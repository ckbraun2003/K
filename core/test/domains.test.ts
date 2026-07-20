import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db } from '../src/db.js'
import {
  listAllDomains, getDomainById, createDomain, updateDomainById,
  domainForProfile, domainForPipelineDef, domainForRun, domainManagedBy,
  domainIdForPipelineLaunch, stampSeededDomainMemberships, slugifyDomainName,
  DomainConflictError,
} from '../src/domains.js'
import { seedProfiles, createProfile } from '../src/profiles.js'
import { seedPipelineSpecs } from '../src/pipeline-seeds.js'
import { instantiatePipeline } from '../src/pipeline-defs.js'

// Shared-file-DB hygiene: every row this suite creates carries a `p51-c1-` prefix
// (or a recorded uuid) and is deleted in afterAll.
const CREATED: { domains: string[]; profiles: string[]; pipelines: string[]; runs: string[] } =
  { domains: [], profiles: [], pipelines: [], runs: [] }

beforeAll(() => {
  seedProfiles()
  seedPipelineSpecs()
  stampSeededDomainMemberships()
})
afterAll(() => {
  // pipeline_stages / pipeline_edges cascade (ON DELETE CASCADE, foreign_keys=ON)
  for (const id of CREATED.pipelines) db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(id)
  for (const id of CREATED.runs) {
    db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(id)
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(id)
  }
  for (const id of CREATED.profiles) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
  for (const id of CREATED.domains) db.prepare(`DELETE FROM domains WHERE id = ?`).run(id)
  // Crash-hardening (quality-review m4): the stamping test NULLs seeded rows mid-test;
  // if a crash lands between the NULL and the re-stamp, restore here so the shared
  // on-disk test DB never leaks unstamped seeded rows into other suites.
  stampSeededDomainMemberships()
})

describe('domains registry (C.1)', () => {
  it('slugifyDomainName: lowercases, hyphenates, strips edges', () => {
    expect(slugifyDomainName('Research & Analysis')).toBe('research-analysis')
    expect(slugifyDomainName('  Engineering  ')).toBe('engineering')
    expect(slugifyDomainName('!!!')).toBe('')
    // ASCII-id policy: accented/non-Latin chars drop out (fully non-Latin → '' → rejected loudly)
    expect(slugifyDomainName('Café')).toBe('caf')
  })

  it('createDomain → getDomainById → listAllDomains round-trip (canonical camelCase shape)', () => {
    const name = `P51 C1 ${randomUUID().slice(0, 8)}`
    const d = createDomain({ name, description: 'test domain', managerProfileId: null })
    CREATED.domains.push(d.id)
    expect(d.id).toBe(slugifyDomainName(name))
    expect(d).toMatchObject({ name, description: 'test domain', managerProfileId: null })
    expect(typeof d.createdAt).toBe('number')
    expect(getDomainById(d.id)).toEqual(d)
    expect(listAllDomains().some(x => x.id === d.id)).toBe(true)
    expect(listAllDomains().some(x => x.id === 'engineering')).toBe(true)
  })

  it('createDomain rejects duplicates (id and name) with DomainConflictError', () => {
    expect(() => createDomain({ name: 'Engineering' })).toThrow(DomainConflictError)
    expect(() => createDomain({ name: '  engineering ' })).toThrow(DomainConflictError)
  })

  it('updateDomainById read-merge-writes and returns null for unknown ids', () => {
    const d = createDomain({ name: `P51 C1 upd ${randomUUID().slice(0, 8)}` })
    CREATED.domains.push(d.id)
    const upd = updateDomainById(d.id, { description: 'patched' })
    expect(upd?.description).toBe('patched')
    expect(upd?.name).toBe(d.name) // untouched field preserved
    expect(updateDomainById('nope-' + randomUUID(), { description: 'x' })).toBeNull()
  })

  it('updateDomainById: rename onto an existing name (any case) throws DomainConflictError; self-rename OK', () => {
    const d = createDomain({ name: `P51 C1 ren ${randomUUID().slice(0, 8)}` })
    CREATED.domains.push(d.id)
    expect(() => updateDomainById(d.id, { name: 'ENGINEERING' })).toThrow(DomainConflictError)
    expect(() => updateDomainById(d.id, { name: '   ' })).toThrow(DomainConflictError)
    // renaming to (a re-cased form of) its OWN name is not a conflict
    expect(updateDomainById(d.id, { name: d.name.toUpperCase() })?.name).toBe(d.name.toUpperCase())
  })

  it('domainForProfile: lead → engineering (column), chief → engineering (manager fallback), unknown/unattributed → null', () => {
    expect(domainForProfile('lead-frontend')?.id).toBe('engineering')
    expect(domainForProfile('chief')?.id).toBe('engineering')
    expect(domainForProfile('nope-' + randomUUID())).toBeNull()
    expect(domainForProfile('k-secretary')).toBeNull()
  })

  it('domainManagedBy: chief manages engineering; leads manage nothing', () => {
    expect(domainManagedBy('chief')?.id).toBe('engineering')
    expect(domainManagedBy('lead-frontend')).toBeNull()
  })

  it('domainForPipelineDef: seeded def → engineering; unknown → null', () => {
    expect(domainForPipelineDef('investigate')?.id).toBe('engineering')
    expect(domainForPipelineDef('nope-' + randomUUID())).toBeNull()
  })

  it('domainIdForPipelineLaunch precedence: def wins → owner fallback → null', () => {
    expect(domainIdForPipelineLaunch('investigate', null)).toBe('engineering')
    expect(domainIdForPipelineLaunch(null, 'lead-backend')).toBe('engineering')
    expect(domainIdForPipelineLaunch(null, null)).toBeNull()
    expect(domainIdForPipelineLaunch('nope-def', 'lead-backend')).toBe('engineering') // unknown def falls through to owner
  })

  it('domainForRun resolves via the agent_runs owning profile', () => {
    const runId = randomUUID()
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, provider, model, tokens_in, tokens_out, cost_usd, created_at)
                VALUES (?, 'x', '.', 'done', 'claude', 'm', 0, 0, 0, ?)`).run(runId, Date.now())
    const arId = randomUUID()
    db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
                VALUES (?, 'lead-systems', ?, 'delegation', 'g', 'completed', ?)`).run(arId, runId, Date.now())
    CREATED.runs.push(arId) // deletes both rows in afterAll (runs delete keyed separately)
    CREATED.runs.push(runId)
    expect(domainForRun(runId)?.id).toBe('engineering')
    expect(domainForRun('nope-' + randomUUID())).toBeNull()
  })
})

describe('bootstrap-side stamping (C.1 hard W0 dependency)', () => {
  it('re-stamps seeded leads + defs whose domain_id was cleared to NULL, and only those', () => {
    db.prepare(`UPDATE agent_profiles SET domain_id = NULL WHERE id = 'lead-network'`).run()
    db.prepare(`UPDATE workflow_definitions SET domain_id = NULL WHERE id = 'quick-task'`).run()
    const custom = createProfile({ name: `p51-c1-${randomUUID().slice(0, 8)}`, tier: 'orchestrator' })
    CREATED.profiles.push(custom.id)
    stampSeededDomainMemberships()
    expect(db.prepare(`SELECT domain_id FROM agent_profiles WHERE id = 'lead-network'`).get())
      .toEqual({ domain_id: 'engineering' })
    expect(db.prepare(`SELECT domain_id FROM workflow_definitions WHERE id = 'quick-task'`).get())
      .toEqual({ domain_id: 'engineering' })
    // operator-created rows are NEVER stamped
    expect(db.prepare(`SELECT domain_id FROM agent_profiles WHERE id = ?`).get(custom.id))
      .toEqual({ domain_id: null })
    // idempotent: second call is a no-op
    stampSeededDomainMemberships()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM domains WHERE id = 'engineering'`).get()).toEqual({ n: 1 })
  })
})

describe('pipeline launch attribution (C.1)', () => {
  // Minimal single-stage spec; instantiatePipeline materializes rows only (no dispatch).
  // Real StageDef field names (id/label/action) — instantiatePipeline reads stage.id.
  const SPEC = {
    name: 'p51-c1-spec',
    stages: [{ kind: 'deterministic' as const, id: 's1', label: 's1', action: { type: 'command' as const, run: 'echo ok' } }],
    edges: [],
    entry: 's1',
  }
  // Real InstantiateOptions: { cwd, goal, ... } — base_commit is resolved from cwd's git
  // HEAD (resolveHeadCommit), so cwd must be a git tree (the worktree is). Returns the
  // pipelineRunId string.
  function instantiate(opts: Record<string, unknown>) {
    const id = instantiatePipeline(SPEC as never, {
      goal: 'p51-c1', cwd: process.cwd(), ...opts,
    } as never)
    CREATED.pipelines.push(id)
    return { id }
  }
  const domainOf = (id: string) =>
    (db.prepare(`SELECT domain_id FROM pipeline_runs WHERE id = ?`).get(id) as { domain_id: string | null }).domain_id

  it('stamps from the definition when definitionId carries a domain', () => {
    const run = instantiate({ definitionId: 'investigate' })
    expect(domainOf(run.id)).toBe('engineering')
  })
  it('falls back to the owner profile domain', () => {
    const run = instantiate({ ownerProfileId: 'lead-frontend' })
    expect(domainOf(run.id)).toBe('engineering')
  })
  it('NULL when neither def nor owner resolves', () => {
    const run = instantiate({})
    expect(domainOf(run.id)).toBeNull()
  })
})
