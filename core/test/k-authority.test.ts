/**
 * A.5 — K primary-agent authority (lane ca-a; D-126).
 *
 * K (secretary tier) becomes the operator's PRIMARY agent: full read/analyze
 * authority (Read/Grep/Glob + the gitnexus code-intelligence server) with no
 * mutation BUILT-INS (Bash/Write/Edit/Task stay denied — the coding-tools gating
 * boundary is untouched). NB `mcp__gitnexus` is a SERVER-level grant (chief
 * parity): gitnexus's write-capable tools (rename, group_sync) ride it — barred
 * by charter as a usage convention, not by this allowlist. Locks:
 *   - resolveAuthority('secretary') over the SHIPPED assets: the new grant set +
 *     the three mounted servers, still no coding tool, gating invariant holds;
 *   - the synthesized run config: allowedTools = OLD set ∪ exactly
 *     {Grep, Glob, mcp__gitnexus}; the denylist still carries every mutation
 *     tool; the written mcp.json mounts gitnexus via `npx gitnexus mcp`;
 *   - the one-shot row reconcile (seedProfiles → reconcileKPrimaryAuthority):
 *     upgrades a PRE-lane k-secretary row, is flag-guarded (second run no-op),
 *     and never re-widens an operator narrowing;
 *   - the write-once identity-overlay seed (only-if-NULL; operator edits win);
 *   - the rewritten charter (primary-agent posture, no route-to-Chief mandate).
 *
 * Shared-DB hygiene (house rule): every profile row this suite seeds is deleted
 * in afterAll, the reconcile flag is restored to its prior state, and a
 * pre-existing k-secretary row's authored fields are restored.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveAuthority, assertCodingToolsGating, CODING_TOOLS } from '../src/authority.js'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { seedProfiles, getProfile, updateProfile } from '../src/profiles.js'
import { db, agentProfilesDb } from '../src/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const FLAG = 'mig_k_primary_authority_v1'
/** The pre-lane (v15-era) secretary grant arrays — what an upgraded DB carries. */
const PRE_LANE_TOOLS = ['Read', 'WebFetch', 'WebSearch', 'mcp__kstore', 'mcp__logistics']
const PRE_LANE_SERVERS = ['kstore', 'logistics']
/** Exactly the grants A.5 adds — nothing more. */
const NEW_GRANTS = ['Grep', 'Glob', 'mcp__gitnexus']

const tmpDirs: string[] = []

// ─── shared-DB hygiene ───────────────────────────────────────────────────────

const createdNames = new Set<string>()
function seedAll(): string[] {
  const created = seedProfiles()
  for (const n of created) createdNames.add(n)
  return created
}

type KRow = {
  name: string; tier: string; charter: string; default_model: string
  allowed_tools: string; mcp_servers: string; skills: string
  identity_overlay: string | null
}
const readKRow = (): KRow | undefined =>
  db.prepare(
    `SELECT name, tier, charter, default_model, allowed_tools, mcp_servers, skills, identity_overlay
     FROM agent_profiles WHERE id = 'k-secretary'`,
  ).get() as KRow | undefined

const flagValue = (): string | undefined =>
  (db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(FLAG) as { value: string } | undefined)?.value
const deleteFlag = (): void => { db.prepare(`DELETE FROM app_config WHERE key = ?`).run(FLAG) }

let priorK: KRow | undefined
let priorFlag: string | undefined

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeAll(() => {
  priorK = readKRow()
  priorFlag = flagValue()
})

beforeEach(() => {
  // Every scenario starts reconcile-clean (the one-shot flag absent)…
  deleteFlag()
  // …and synthesis resolves auth via the token path (never copies host credentials).
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})

afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
})

afterAll(() => {
  // Delete every seed row THIS suite created (profiles.test.ts convention).
  for (const name of createdNames) {
    try { db.prepare(`DELETE FROM agent_profiles WHERE name = ?`).run(name) } catch { /* FK guard */ }
  }
  // Restore the reconcile flag to its pre-suite state.
  deleteFlag()
  if (priorFlag !== undefined) db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`).run(FLAG, priorFlag)
  // Restore a PRE-EXISTING k-secretary row's authored fields (we mutated them).
  if (priorK && !createdNames.has('K')) {
    db.prepare(
      `UPDATE agent_profiles
       SET name = @name, tier = @tier, charter = @charter, default_model = @default_model,
           allowed_tools = @allowed_tools, mcp_servers = @mcp_servers, skills = @skills,
           identity_overlay = @identity_overlay
       WHERE id = 'k-secretary'`,
    ).run(priorK)
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ─── 1. tier authority over the shipped assets ───────────────────────────────

describe('resolveAuthority(secretary) — the primary-agent grant set', () => {
  it('grants Read/Grep/Glob/WebFetch/WebSearch + the three mcp servers; excludes every coding tool', () => {
    const a = resolveAuthority('secretary')
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__gitnexus', 'mcp__kstore', 'mcp__logistics']) {
      expect(a.allowedTools, `secretary must grant ${tool}`).toContain(tool)
    }
    expect([...a.mcpServers].sort()).toEqual(['gitnexus', 'kstore', 'logistics'])
    for (const tool of CODING_TOOLS) {
      expect(a.allowedTools, `secretary must NOT grant ${tool}`).not.toContain(tool)
    }
    expect(a.allowedTools).not.toContain('Agent')
    // The whole-asset gating invariant still holds with the widened secretary grant.
    expect(() => assertCodingToolsGating()).not.toThrow()
  })
})

// ─── 2. grant snapshot via synthesis ─────────────────────────────────────────

describe('synthesizeConfigDir — the reconciled k-secretary run grant', () => {
  it('allowedTools = OLD set ∪ exactly {Grep, Glob, mcp__gitnexus}; denylist intact; gitnexus mounted via npx', () => {
    seedAll() // flag was cleared in beforeEach → the reconcile upgrades/creates the row
    const k = getProfile('k-secretary')
    expect(k).not.toBeNull()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-a5-synth-'))
    tmpDirs.push(dataDir)
    const runId = 'run-a5-' + Math.random().toString(36).slice(2)
    const cfg = synthesizeConfigDir(k!, { runId, dataDir, assetsDir: ASSET_DIR })

    // Byte-diff: sorted new set minus sorted old set === exactly the three grants.
    const sortedNew = [...cfg.allowedTools].sort()
    const diff = sortedNew.filter(t => !PRE_LANE_TOOLS.includes(t))
    expect(diff).toEqual([...NEW_GRANTS].sort())
    expect(sortedNew).toEqual([...PRE_LANE_TOOLS, ...NEW_GRANTS].sort())

    // The mutation denylist is untouched: every write-capable tool stays denied.
    for (const denied of ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent']) {
      expect(cfg.disallowedTools, `denylist must carry ${denied}`).toContain(denied)
    }

    // The written mcp.json mounts gitnexus as the portable npx stdio server.
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>
    }
    expect(mcp.mcpServers.gitnexus).toBeDefined()
    expect(mcp.mcpServers.gitnexus.command).toBe('npx')
    expect(mcp.mcpServers.gitnexus.args).toEqual(['gitnexus', 'mcp'])
  })
})

// ─── 3. one-shot row reconcile ───────────────────────────────────────────────

describe('seedProfiles — one-shot k-secretary grant reconcile (mig_k_primary_authority_v1)', () => {
  it('upgrades a PRE-lane row, sets the flag, no-ops on re-run, and never re-widens an operator narrowing', () => {
    seedAll() // stand up the roster (whatever its current state)
    // Regress k-secretary to the exact PRE-lane arrays via a RAW row write (what an
    // upgraded v15 DB carries — updateProfile would be the post-lane path).
    const skills = readKRow()!.skills
    agentProfilesDb.updateProfileRow.run({
      id: 'k-secretary', name: 'K', tier: 'secretary', charter: 'secretary', defaultModel: '',
      allowedTools: JSON.stringify(PRE_LANE_TOOLS), mcpServers: JSON.stringify(PRE_LANE_SERVERS), skills,
      // C.2 (merged at INT): updateProfileRow's named-param set carries the L1.5
      // overlay column. A PRE-lane row never had one — NULL is the regressed state
      // (and lets the reconcile's overlay seed do its write-once work).
      identityOverlay: null,
    })
    deleteFlag() // seedAll above set it — the scenario under test starts unflagged

    seedAll() // → reconcileKPrimaryAuthority upgrades the row
    const k = getProfile('k-secretary')!
    expect([...k.allowedTools].sort()).toEqual([...PRE_LANE_TOOLS, ...NEW_GRANTS].sort())
    expect([...k.mcpServers].sort()).toEqual(['gitnexus', 'kstore', 'logistics'])
    expect(flagValue(), 'reconcile flag must be set after success').toBeDefined()

    // A SECOND seedProfiles is a no-op (flag-guarded): the row is byte-identical.
    const before = readKRow()
    seedAll()
    expect(readKRow()).toEqual(before)

    // An operator NARROWING made after the reconcile survives later seeds (flag set).
    updateProfile('k-secretary', { allowedTools: PRE_LANE_TOOLS, mcpServers: PRE_LANE_SERVERS })
    seedAll()
    expect(getProfile('k-secretary')!.allowedTools).toEqual(PRE_LANE_TOOLS)
    expect(getProfile('k-secretary')!.mcpServers).toEqual(PRE_LANE_SERVERS)
  })
})

// ─── 4. identity-overlay seed (write-once) ───────────────────────────────────

describe('seedProfiles — k-secretary identity-overlay seed (only-if-NULL)', () => {
  it('seeds a non-empty overlay containing "K"; an operator-edited overlay is never overwritten', () => {
    seedAll()
    // Start from the NULL-overlay state (what a pre-lane row carries).
    db.prepare(`UPDATE agent_profiles SET identity_overlay = NULL WHERE id = 'k-secretary'`).run()
    deleteFlag()

    seedAll()
    const overlay = readKRow()!.identity_overlay
    expect(typeof overlay).toBe('string')
    expect((overlay ?? '').length).toBeGreaterThan(0)
    expect(overlay).toContain('K')

    // Operator edits the overlay; even a FORCED re-reconcile (flag cleared) must not
    // overwrite it — the setter only fills a NULL column.
    db.prepare(`UPDATE agent_profiles SET identity_overlay = ? WHERE id = 'k-secretary'`)
      .run('operator-edited overlay')
    deleteFlag()
    seedAll()
    expect(readKRow()!.identity_overlay).toBe('operator-edited overlay')

    // An operator-CLEARED overlay ('' — non-NULL) is likewise preserved: in
    // SQLite '' IS NOT NULL, so the only-if-NULL setter never touches it.
    db.prepare(`UPDATE agent_profiles SET identity_overlay = '' WHERE id = 'k-secretary'`).run()
    deleteFlag()
    seedAll()
    expect(readKRow()!.identity_overlay).toBe('')
  })
})

// ─── 5. charter posture ──────────────────────────────────────────────────────

describe('secretary.charter.md — the primary-agent role template', () => {
  it('names the read/delegation posture and drops the route-to-Chief mandate', () => {
    const body = fs.readFileSync(path.join(ASSET_DIR, 'tiers', 'secretary.charter.md'), 'utf8')
    // Stable phrases of the new posture.
    expect(body).toContain('# Secretary Charter (K)') // the S4-008 L1 marker survives
    expect(body.toLowerCase()).toContain('primary agent')
    expect(body.toLowerCase()).toContain('delegate')
    // The routing-era mandate is gone (robust negatives — 'Chief' alone may still
    // legitimately appear; the MANDATE phrasing must not).
    expect(body).not.toContain('every request')
    expect(body.toLowerCase()).not.toContain('dispatch engineering')
    expect(body.toLowerCase()).not.toContain('bubble back up')
  })
})
