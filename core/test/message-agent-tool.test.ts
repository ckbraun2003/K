/**
 * message_agent — the kstore mailbox tool (Continuous Agents B.3). Sender resolved
 * from K_RUN_ID → agent_runs; mayMessage-gated; typed rejections.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../src/db.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { kStoreTools, KStoreError } from '../src/mcp/k-store.js'

type Row = Record<string, unknown>
const tool = kStoreTools.find(t => t.name === 'message_agent')!

const SENDER = 'ca-b-tool-sender'   // orchestrator (tightest tier — gate visible)
const MGR = 'ca-b-tool-mgr'         // chief managing ca-b-tool-domain (sender's domain)
const created: string[] = []

function ensureProfile(id: string, name: string, tier: 'secretary' | 'chief' | 'orchestrator') {
  if (!getProfile(id)) { createProfile({ id, name, tier }); created.push(id) }
}

/** A runs row + agent_runs activation linking it to `profileId`; returns run id. */
function seedAgentRun(profileId: string): string {
  const runId = `ca-b-tool-run-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'x', '.', 'running', ?)`).run(runId, Date.now())
  db.prepare(
    `INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
     VALUES (?, ?, ?, 'delegation', 'ca-b', 'running', ?)`,
  ).run(randomUUID(), profileId, runId, Date.now())
  return runId
}

function cleanup() {
  // Scoped to THIS file's namespace (shared-DB discipline): to-side covers the only
  // legit target (MGR); from-side covers a gate-regression leak (e.g. a wrongly-queued
  // send to k-secretary, which no to-side ca-b filter would ever delete).
  db.prepare(
    `DELETE FROM agent_messages WHERE to_profile_id LIKE 'ca-b-tool-%' OR from_profile_id LIKE 'ca-b-tool-%'`,
  ).run()
  db.prepare(`DELETE FROM k_threads WHERE id LIKE 'kt-ca-b-%'`).run()
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'ca-b-tool-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'ca-b-tool-run-%'`).run()
}

beforeAll(() => {
  ensureProfile('k-secretary', 'K', 'secretary')
  ensureProfile(SENDER, 'CaBToolSender', 'orchestrator')
  ensureProfile(MGR, 'CaBToolMgr', 'chief')
  db.prepare(
    `INSERT OR IGNORE INTO domains (id, name, description, manager_profile_id, created_at) VALUES (?, ?, NULL, ?, ?)`,
  ).run('ca-b-tool-domain', 'CaB Tool Domain', MGR, Date.now())
  db.prepare(`UPDATE agent_profiles SET domain_id = 'ca-b-tool-domain' WHERE id = ?`).run(SENDER)
})
beforeEach(cleanup)
afterAll(() => {
  cleanup()
  db.prepare(`DELETE FROM domains WHERE id = 'ca-b-tool-domain'`).run()
  for (const id of created) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
})

describe('message_agent', () => {
  it('is registered with the to/body/priority shape', () => {
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputShape).sort()).toEqual(['body', 'priority', 'to'])
  })

  it('queues from the calling run profile: provenance + resolved conversation stamped', () => {
    const runId = seedAgentRun(SENDER)
    const out = tool.handler({ to: MGR, body: 'wave 2 blocked on review' }, { runId }) as Row

    expect(out.to).toBe(MGR)
    expect(out.status).toBe('queued')
    expect(out.priority).toBe('normal')
    const row = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(String(out.id)) as Row
    expect(row.from_kind).toBe('profile')
    expect(row.from_profile_id).toBe(SENDER)
    expect(row.provenance_run_id).toBe(runId)
    expect(row.to_thread_id).toBe(`kt-${MGR}`) // conversation resolved at queue time
  })

  it('resolves the target by unique profile NAME too, and passes priority through', () => {
    const runId = seedAgentRun(SENDER)
    const out = tool.handler({ to: 'CaBToolMgr', body: 'gate!', priority: 'urgent' }, { runId }) as Row
    expect(out.to).toBe(MGR)
    expect(out.priority).toBe('urgent')
  })

  it('rejects an unknown target profile (typed)', () => {
    const runId = seedAgentRun(SENDER)
    expect(() => tool.handler({ to: 'ca-b-nobody', body: 'x' }, { runId }))
      .toThrow(KStoreError)
    expect(() => tool.handler({ to: 'ca-b-nobody', body: 'x' }, { runId }))
      .toThrow(/unknown agent profile/)
  })

  it('rejects an ungated pair (orchestrator → K) with the tier-gate error', () => {
    const runId = seedAgentRun(SENDER)
    expect(() => tool.handler({ to: 'k-secretary', body: 'hi K' }, { runId }))
      .toThrow(/tier gate/)
    // Scoped to this file's sender (shared-DB discipline): the rejected call queued NOTHING.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE from_profile_id LIKE 'ca-b-tool-%'`).get(),
    ).toEqual({ n: 0 })
  })

  it('rejects a whitespace-only body as a TYPED caller error (zod min(1) does not trim)', () => {
    const runId = seedAgentRun(SENDER)
    // Pins the tool-boundary AgentMailError→KStoreError rewrap — without it the mail
    // layer's throw surfaces as the glue's generic "internal error". Different layer
    // than agent-mail.test.ts's queueMessage pin (that one is store-level).
    expect(() => tool.handler({ to: MGR, body: '   ' }, { runId })).toThrow(KStoreError)
    expect(() => tool.handler({ to: MGR, body: '   ' }, { runId })).toThrow(/non-empty/)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE from_profile_id LIKE 'ca-b-tool-%'`).get(),
    ).toEqual({ n: 0 })
  })

  it('rejects a run with no owning profile / no run context (typed)', () => {
    expect(() => tool.handler({ to: MGR, body: 'x' }, { runId: null })).toThrow(/managed run/)
    const bare = `ca-b-tool-run-${randomUUID().slice(0, 8)}`
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'x', '.', 'running', ?)`).run(bare, Date.now())
    expect(() => tool.handler({ to: MGR, body: 'x' }, { runId: bare })).toThrow(/owning agent profile/)
  })
})
