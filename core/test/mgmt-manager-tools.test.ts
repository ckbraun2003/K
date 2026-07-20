/**
 * Manager supervision tools (Continuous Agents C.5, D-125): resolve_gate, steer,
 * and the report→K dual-write, exercised directly through the mgmtTools registry
 * against the real DB singleton (the mgmt.test.ts harness convention).
 *
 * Fixtures: seedProfiles() + stampSeededDomainMemberships() give domain
 * 'engineering' managed by 'chief' with the five leads as members; 'k-secretary'
 * is unattributed (always steerable); 'default-orchestrator' exists and is NOT an
 * engineering member (the out-of-domain profile).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db } from '../src/db.js'
import { seedProfiles } from '../src/profiles.js'
import { stampSeededDomainMemberships } from '../src/domains.js'
import { mgmtTools, MgmtError, type MgmtContext } from '../src/mcp/mgmt.js'

const tool = (name: string) => {
  const t = mgmtTools.find(t => t.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}
const T = Date.now()
const cleanupSql: Array<[string, string]> = [] // [table, id] — deleted in push order
// pipeline_ledger has NO FK to pipeline_runs (loose ref), so resolveGate's audit
// entries would linger in the shared test DB — track run ids and wipe explicitly.
const pipelineRunIds: string[] = []

/** A run + agent_runs pair owned by `profileId`; returns the ctx for that run. */
function ctxFor(profileId: string): MgmtContext {
  const runId = randomUUID()
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, provider, model, tokens_in, tokens_out, cost_usd, created_at)
              VALUES (?, 'x', '.', 'running', 'claude', 'm', 0, 0, 0, ?)`).run(runId, T)
  const arId = randomUUID()
  db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
              VALUES (?, ?, ?, 'event', 'g', 'running', ?)`).run(arId, profileId, runId, T)
  cleanupSql.push(['agent_runs', arId], ['runs', runId])
  return { runId }
}
function domainPipeline(domainId: string | null): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO pipeline_runs (id, definition_id, project_id, title, cwd, base_commit, status, created_at, updated_at, completed_at, owner_profile_id, domain_id)
              VALUES (?, NULL, NULL, 'mgr-test', '.', 'base', 'running', ?, ?, NULL, NULL, ?)`)
    .run(id, T, T, domainId)
  cleanupSql.push(['pipeline_runs', id]) // pipeline_stages cascade (FK ON DELETE CASCADE)
  pipelineRunIds.push(id)
  return id
}
function gateStage(pipelineRunId: string): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO pipeline_stages (id, pipeline_run_id, stage_key, kind, spec, status, created_at, updated_at)
              VALUES (?, ?, 'approve', 'gate', '{}', 'awaiting_gate', ?, ?)`).run(id, pipelineRunId, T, T)
  return id
}
const steerRows = () =>
  db.prepare(`SELECT * FROM agent_messages WHERE from_profile_id = 'chief' AND to_profile_id != 'chief' ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>

beforeAll(() => { seedProfiles(); stampSeededDomainMemberships() })
beforeEach(() => {
  db.prepare(`DELETE FROM agent_messages WHERE from_profile_id = 'chief'`).run()
})
afterAll(() => {
  db.prepare(`DELETE FROM agent_messages WHERE from_profile_id = 'chief'`).run()
  for (const id of pipelineRunIds) {
    db.prepare(`DELETE FROM pipeline_ledger WHERE pipeline_run_id = ?`).run(id)
  }
  for (const [table, id] of cleanupSql) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
})

describe('resolve_gate (C.5)', () => {
  it('manager resolves an in-domain gate; CAS: second call is a clean MgmtError', async () => {
    const pr = domainPipeline('engineering')
    const sid = gateStage(pr)
    const out = await tool('resolve_gate').handler({ gateId: sid, decision: 'approve', note: 'ok' }, ctxFor('chief'))
    expect(out).toMatchObject({ ok: true, decision: 'approve' })
    const stage = db.prepare(`SELECT status, gate_resolved_by FROM pipeline_stages WHERE id = ?`).get(sid)
    expect(stage).toEqual({ status: 'passed', gate_resolved_by: 'chief' })
    await expect(async () =>
      tool('resolve_gate').handler({ gateId: sid, decision: 'approve' }, ctxFor('chief')),
    ).rejects.toThrow(MgmtError)
  })

  it('rejects: out-of-domain gate, unattributed pipeline, unknown gate, non-manager caller, no run ctx', async () => {
    const foreign = gateStage(domainPipeline(null))
    await expect(async () =>
      tool('resolve_gate').handler({ gateId: foreign, decision: 'approve' }, ctxFor('chief')),
    ).rejects.toThrow(/outside your domain/)
    await expect(async () =>
      tool('resolve_gate').handler({ gateId: 'nope-' + randomUUID(), decision: 'reject' }, ctxFor('chief')),
    ).rejects.toThrow(/not found/)
    const inDomain = gateStage(domainPipeline('engineering'))
    await expect(async () =>
      tool('resolve_gate').handler({ gateId: inDomain, decision: 'approve' }, ctxFor('lead-frontend')),
    ).rejects.toThrow(/do not manage/)
    await expect(async () =>
      tool('resolve_gate').handler({ gateId: inDomain, decision: 'approve' }, { runId: null }),
    ).rejects.toThrow(MgmtError)
  })
})

describe('steer (C.5)', () => {
  it('queues a mailbox row to a domain member (provenance-stamped, thread NULL — relay pairs at delivery)', async () => {
    const ctx = ctxFor('chief')
    const out = await tool('steer').handler({ toProfileId: 'lead-frontend', body: 'focus on the flaky suite', priority: 'urgent' }, ctx)
    expect(out).toMatchObject({ ok: true, to: 'lead-frontend', priority: 'urgent' })
    const rows = steerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      to_profile_id: 'lead-frontend', to_thread_id: null, from_kind: 'profile',
      from_profile_id: 'chief', priority: 'urgent', status: 'queued', provenance_run_id: ctx.runId,
    })
  })

  it('resolves runId → owning profile', async () => {
    const target = ctxFor('lead-backend') // creates a lead-owned run
    await tool('steer').handler({ runId: target.runId, body: 'wrap up' }, ctxFor('chief'))
    expect(steerRows()[0]).toMatchObject({ to_profile_id: 'lead-backend', priority: 'normal' })
  })

  it('gate matrix: K allowed; non-member denied; SELF denied; exactly-one-target enforced', async () => {
    await tool('steer').handler({ toProfileId: 'k-secretary', body: 'fyi' }, ctxFor('chief'))
    expect(steerRows()[0]).toMatchObject({ to_profile_id: 'k-secretary' })
    await expect(async () =>
      tool('steer').handler({ toProfileId: 'default-orchestrator', body: 'x' }, ctxFor('chief')),
    ).rejects.toThrow(/outside your domain/)
    await expect(async () =>
      tool('steer').handler({ toProfileId: 'chief', body: 'x' }, ctxFor('chief')),
    ).rejects.toThrow(/yourself/)
    // Belt-and-braces on the discriminator: no self-addressed row may exist (the
    // steerRows() helper filters to != 'chief', so assert the forgery shape directly).
    const selfRows = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_profile_id = 'chief' AND from_profile_id = 'chief'`).get() as { n: number }
    expect(selfRows.n).toBe(0)
    await expect(async () =>
      tool('steer').handler({ body: 'x' }, ctxFor('chief')),
    ).rejects.toThrow(/exactly one/)
    await expect(async () =>
      tool('steer').handler({ toProfileId: 'lead-frontend', runId: 'r', body: 'x' }, ctxFor('chief')),
    ).rejects.toThrow(/exactly one/)
    await expect(async () =>
      tool('steer').handler({ toProfileId: 'lead-frontend', body: 'x' }, ctxFor('lead-frontend')),
    ).rejects.toThrow(/do not manage/)
  })
})

describe('multi-domain manager (C.5)', () => {
  it('a manager of TWO domains can act in both — second (newest) domain gate + member reachable', async () => {
    // created_at far NEWER than the seeded 'engineering' stamp: an oldest-first
    // LIMIT-1 manager lookup would lock this domain out (the reviewed bug shape).
    db.prepare(`INSERT INTO domains (id, name, description, manager_profile_id, created_at)
                VALUES ('ops-c5', 'Ops C5', NULL, 'chief', ?)`).run(T + 1_000_000)
    cleanupSql.push(['domains', 'ops-c5'])
    const sid = gateStage(domainPipeline('ops-c5'))
    const out = await tool('resolve_gate').handler({ gateId: sid, decision: 'approve' }, ctxFor('chief'))
    expect(out).toMatchObject({ ok: true, decision: 'approve' })
    const prev = (db.prepare(`SELECT domain_id FROM agent_profiles WHERE id = 'default-orchestrator'`)
      .get() as { domain_id: string | null }).domain_id
    db.prepare(`UPDATE agent_profiles SET domain_id = 'ops-c5' WHERE id = 'default-orchestrator'`).run()
    try {
      await tool('steer').handler({ toProfileId: 'default-orchestrator', body: 'second-domain steer' }, ctxFor('chief'))
      expect(steerRows().some(r => r.to_profile_id === 'default-orchestrator' && r.body === 'second-domain steer')).toBe(true)
    } finally {
      db.prepare(`UPDATE agent_profiles SET domain_id = ? WHERE id = 'default-orchestrator'`).run(prev)
    }
  })
})

describe('report dual-write (C.5)', () => {
  it('a manager report ALSO queues a message to K (report store row preserved)', async () => {
    const ctx = ctxFor('chief')
    const before = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_profile_id = 'k-secretary' AND from_profile_id = 'chief'`).get() as { n: number }
    const rep = await tool('report').handler({ body: 'weekly domain summary' }, ctx) as { id: string; body: string; runId: string | null }
    cleanupSql.push(['mgmt_reports', rep.id])
    const after = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_profile_id = 'k-secretary' AND from_profile_id = 'chief'`).get() as { n: number }
    expect(after.n).toBe(before.n + 1)
    const msg = db.prepare(`SELECT * FROM agent_messages WHERE to_profile_id = 'k-secretary' AND from_profile_id = 'chief' ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>
    expect(msg).toMatchObject({ from_kind: 'profile', priority: 'normal', body: 'weekly domain summary', provenance_run_id: ctx.runId })
    // The existing MgmtReport store row is preserved exactly as today (additive dual-write).
    expect(rep).toMatchObject({ body: 'weekly domain summary', runId: ctx.runId })
    const stored = db.prepare(`SELECT body, run_id FROM mgmt_reports WHERE id = ?`).get(rep.id)
    expect(stored).toEqual({ body: 'weekly domain summary', run_id: ctx.runId })
  })

  it('a no-run-context report files the durable report row only (no mailbox write)', async () => {
    const rep = await tool('report').handler({ body: 'legacy report c5' }, { runId: null }) as { id: string }
    cleanupSql.push(['mgmt_reports', rep.id])
    // Body-scoped (not a global COUNT) so a parallel worker writing agent_messages
    // in the shared data dir cannot flake this.
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE body = 'legacy report c5'`).get() as { n: number }
    expect(rows.n).toBe(0)
    expect(db.prepare(`SELECT body FROM mgmt_reports WHERE id = ?`).get(rep.id)).toEqual({ body: 'legacy report c5' })
  })

  it('a k-secretary report never writes a self-addressed mailbox row (discriminator invariant local to the write)', async () => {
    const rep = await tool('report').handler({ body: 'k self probe c5' }, ctxFor('k-secretary')) as { id: string }
    cleanupSql.push(['mgmt_reports', rep.id])
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE body = 'k self probe c5'`).get() as { n: number }
    expect(rows.n).toBe(0)
    expect(db.prepare(`SELECT body FROM mgmt_reports WHERE id = ?`).get(rep.id)).toEqual({ body: 'k self probe c5' })
  })
})
