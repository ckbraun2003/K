/**
 * lead-dispatch-relay.ts — the MAIN-process drain for the Chief→lead dispatch queue (loop-b).
 *
 * This is the EXECUTION half of the two-phase decoupling: `dispatch_lead` (mgmt.ts, in the
 * ephemeral child) only RECORDS a 'pending' intent; `drainLeadDispatches()` (here, in the
 * long-lived main process) claims + executes each intent via startAgentRun, records the
 * Chief→lead link, and wires the report-back. These tests exercise the drain directly.
 *
 * `supervisor.startRun` is mocked (same pattern as chief-dispatch / chief-wake tests) so no
 * real agent spawns; the mock inserts a real `runs` row because agent_runs.run_id,
 * lead_dispatches.lead_run_id and mgmt_assignments.lead_run_id all FK → runs(id). Modules
 * that transitively import the mocked supervisor (mgmt.js via db, agent-runs.js, the relay,
 * chief-dispatch.js) are imported AFTER the mock is registered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, mgmtDb, leadDispatchDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { seedProfiles } from '../src/profiles.js'
import { seedWorkflowDefinitions } from '../src/workflow-defs.js'
import type { Assignment, Run } from '@k/shared'

// startRun mocked so no real agent spawns, but it MUST insert a real runs row:
// agent_runs.run_id / lead_dispatches.lead_run_id / mgmt_assignments.lead_run_id all FK → runs(id).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-relay-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'relay', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Modules under test — imported AFTER the mock so the transitive supervisor is mocked.
const { mgmtTools } = await import('../src/mcp/mgmt.js')
const { drainLeadDispatches, startLeadDispatchRelay } = await import('../src/lead-dispatch-relay.js')

// ── fixtures + helpers ────────────────────────────────────────────────────────

const CHIEF_RUN = uuid() // the delegation parent (a real runs row)
const K_THREAD = `relay-k-thread-${uuid().slice(0, 8)}` // the K thread that delegated CHIEF_RUN

type Ctx = { runId: string | null }
const ctxChief: Ctx = { runId: CHIEF_RUN }

/** Invoke a mgmt tool by name (as the mgmt-server would). All mgmt tools are sync now. */
function call(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

interface DispatchResult {
  assignmentId: string
  leadProfileId: string
  workflowId: string
  dispatchId: string
  status: 'pending'
}

/** Record an intent for a fresh Frontend assignment; returns { assignmentId, dispatchId }. */
function recordIntent(objective: string): { assignmentId: string; dispatchId: string } {
  const assigned = call('assign_lead', { lead: 'Frontend', objective }, ctxChief) as Assignment
  const res = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as DispatchResult
  return { assignmentId: assigned.id, dispatchId: res.dispatchId }
}

/** Let a fire-and-forget lifecycle settle (the report-back rides the async seam). */
const flush = () => new Promise(r => setTimeout(r, 30))

/** A terminal Run event for `id` (minimal shape the run-lifecycle seam reads). */
function terminalRun(id: string, status: Run['status'] = 'done'): Run {
  return { id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run
}

/** Insert a real runs row so an FK-bound row/event has a target. */
function insertRunRow(id: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'relay', '.', ?, ?)`,
  ).run(id, status, Date.now())
}

/** Insert a single `assistant` event for a run so the report-back summary is non-empty. */
function insertAssistantEvent(runId: string, text: string): void {
  db.prepare(
    `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'assistant', ?, ?)`,
  ).run(uuid(), runId, 1, Date.now(), text)
}

/** lead-frontend activations whose seeded goal carries a per-case marker. */
function leadActivations(marker: string): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM agent_runs WHERE profile_id = 'lead-frontend' AND goal LIKE ?`)
    .all(`%${marker}%`) as Array<Record<string, unknown>>
}

const intent = (dispatchId: string) => leadDispatchDb.getLeadDispatch.get(dispatchId) as Record<string, unknown>
const assignmentLeadRun = (assignmentId: string) =>
  (mgmtDb.getAssignment.get(assignmentId) as Record<string, unknown>).lead_run_id

beforeAll(() => {
  // Idempotent shared seeds (durable lead roster + workflow templates) + the Chief parent run.
  seedProfiles()
  seedWorkflowDefinitions()
  insertRunRow(CHIEF_RUN)
})

afterAll(() => {
  // FK-safe order: k_thread_turns → k_threads (the Chief→K continuation fixtures) →
  // events → mgmt_reports → lead_dispatches → mgmt_assignments → agent_runs (SET NULL) →
  // runs. Only our rows; shared durable seeds are left intact.
  db.prepare(`DELETE FROM agent_messages WHERE to_thread_id = ?`).run(K_THREAD)
  db.prepare(`DELETE FROM k_thread_turns WHERE thread_id = ?`).run(K_THREAD)
  db.prepare(`DELETE FROM k_threads WHERE id = ?`).run(K_THREAD)
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-relay-run-%'`).run()
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM lead_dispatches WHERE chief_run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-relay-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-relay-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(CHIEF_RUN)
})

// ── 1. record → drain happy path ─────────────────────────────────────────────

describe('drainLeadDispatches: record → drain', () => {
  it('records a pending intent (no run), then the drain executes it and links everything', async () => {
    const MARK = 'RELAY-HAPPY'
    const { assignmentId, dispatchId } = recordIntent(MARK)

    // Recorded but NOT executed: pending intent, no lead activation, link still NULL.
    expect(intent(dispatchId).status).toBe('pending')
    expect(intent(dispatchId).lead_run_id).toBeNull()
    expect(assignmentLeadRun(assignmentId)).toBeNull()
    expect(leadActivations(MARK)).toHaveLength(0)

    // Drain executes the one pending intent in the main process.
    expect(await drainLeadDispatches()).toBe(1)

    const runId = String(assignmentLeadRun(assignmentId))
    expect(runId).toMatch(/^mock-relay-run-/)
    // A lead-frontend activation: delegation trigger, code-wave workflow, seeded goal.
    const ar = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>
    expect(ar.profile_id).toBe('lead-frontend')
    expect(ar.trigger).toBe('delegation')
    expect(ar.workflow_id).toBe('code-wave')
    expect(String(ar.goal)).toContain(MARK)
    // The intent is retired 'dispatched' with the run id recorded.
    expect(intent(dispatchId).status).toBe('dispatched')
    expect(intent(dispatchId).lead_run_id).toBe(runId)
  })

  // ── 2. report-back fires on the MAIN EventBus ──────────────────────────────
  it('wires the lead→Chief report-back — it fires on the main EventBus terminal', async () => {
    const MARK = 'RELAY-REPORT'
    const { assignmentId } = recordIntent(MARK)
    await drainLeadDispatches()
    const runId = String(assignmentLeadRun(assignmentId))

    insertAssistantEvent(runId, 'Frontend lead: shipped the PR.')
    eventBus.emitRunUpdate(terminalRun(runId, 'done'))
    await flush()

    const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 50) as Array<Record<string, unknown>>
    const match = reports.filter(
      r => String(r.body).includes('Lead') && String(r.body).includes('completed'),
    )
    expect(match.length).toBeGreaterThan(0)
    expect(match.some(r => String(r.body).includes('shipped the PR'))).toBe(true)
  })

  // ── 3. startAgentRun failure in drain degrades (no throw) ───────────────────
  it('a startAgentRun failure in the drain degrades (no throw), marks the intent failed', async () => {
    const MARK = 'RELAY-FAIL'
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))
    const { assignmentId, dispatchId } = recordIntent(MARK)

    // Drain resolves (no throw) with a 0 success count — the lone intent failed.
    await expect(drainLeadDispatches()).resolves.toBe(0)

    // Intent marked failed; the assignment link stays NULL (retryable); no completed lead.
    expect(intent(dispatchId).status).toBe('failed')
    expect(assignmentLeadRun(assignmentId)).toBeNull()
    const mine = leadActivations(MARK)
    expect(mine.every(r => r.status !== 'completed')).toBe(true)
  })

  // ── 4. re-entrancy / claim: an intent is executed exactly once ──────────────
  it('claims each intent exactly once even across overlapping drains', async () => {
    const MARK = 'RELAY-CLAIM'
    const { dispatchId } = recordIntent(MARK)

    // Two overlapping drains: the second re-enters the still-running first (draining guard),
    // so between them the intent is executed exactly ONCE.
    const [a, b] = await Promise.all([drainLeadDispatches(), drainLeadDispatches()])
    expect(a + b).toBe(1)
    expect(leadActivations(MARK)).toHaveLength(1)

    // The executed intent is now 'dispatched' — the atomic claim CAS refuses to re-claim it
    // (the cross-process guard: a second claimant sees changes===0 and skips).
    expect(leadDispatchDb.claimLeadDispatch.run({ id: dispatchId, dispatchedAt: Date.now() }).changes).toBe(0)

    // Nothing left pending — a follow-up drain is a no-op.
    expect(await drainLeadDispatches()).toBe(0)
  })

  // ── 4b. the atomic pending→dispatched CAS itself (the cross-process guard) ────
  it('claimLeadDispatch is an atomic pending→dispatched CAS — a second claimant loses', () => {
    const MARK = 'RELAY-CAS'
    const { dispatchId } = recordIntent(MARK)

    // First claimant flips pending→dispatched (changes===1); a second concurrent claimant
    // on the same row sees changes===0 — the exactly-once guard the relay relies on across
    // overlapping drains AND (in production) across the single main-process relay.
    expect(leadDispatchDb.claimLeadDispatch.run({ id: dispatchId, dispatchedAt: Date.now() }).changes).toBe(1)
    expect(leadDispatchDb.claimLeadDispatch.run({ id: dispatchId, dispatchedAt: Date.now() }).changes).toBe(0)
    expect(intent(dispatchId).status).toBe('dispatched')
    // This intent is now stranded 'dispatched' with no lead_run_id — exactly the state the
    // boot sweep reconcileOrphanedLeadDispatches rescues; here we assert only the CAS.
  })
})

// ── 6. Chief→K continuation — the lead terminal continues up to K (loop-b2) ──

describe('drainLeadDispatches: Chief→K report continuation', () => {
  it('continues the lead outcome UP onto K\'s thread when the Chief run was a K delegation', async () => {
    // Link the Chief run to a K thread exactly as delegateToChief does (a k_thread_turn
    // whose run_id = the Chief run) — the derivable K→Chief edge, no new table.
    const now = Date.now()
    db.prepare(
      `INSERT INTO k_threads (id, title, status, active_run_id, created_at, updated_at) VALUES (?, NULL, 'active', NULL, ?, ?)`,
    ).run(K_THREAD, now, now)
    db.prepare(
      `INSERT INTO k_thread_turns (id, thread_id, role, text, run_id, created_at) VALUES (?, ?, 'user', 'ship the org tree', ?, ?)`,
    ).run(uuid(), K_THREAD, CHIEF_RUN, now)

    const MARK = 'RELAY-KCONT'
    const { assignmentId } = recordIntent(MARK)
    await drainLeadDispatches()
    const runId = String(assignmentLeadRun(assignmentId))

    insertAssistantEvent(runId, 'Lead: opened PR #99; CI green.')
    eventBus.emitRunUpdate(terminalRun(runId, 'done'))
    await flush()

    // The lead→Chief mgmt report still fires (unchanged), AND the outcome continues one
    // more hop up as a QUEUED agent message (B.4) — from the LEAD's own profile (the
    // drain's startAgentRun gave the lead run an agent_runs row), to K's thread; the
    // relay delivers it, so NO 'k' turn is appended directly.
    const msgs = db
      .prepare(`SELECT * FROM agent_messages WHERE to_thread_id = ? ORDER BY created_at ASC, id ASC`)
      .all(K_THREAD) as Array<Record<string, unknown>>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to_profile_id).toBe('k-secretary')
    expect(msgs[0].from_kind).toBe('profile')
    expect(msgs[0].from_profile_id).toBe('lead-frontend') // the reporting lead, via its activation
    expect(msgs[0].provenance_run_id).toBe(runId) // the lead run
    expect(String(msgs[0].body)).toContain('opened PR #99')
    expect(String(msgs[0].body)).toContain('Chief (via Frontend)')
    expect(String(msgs[0].body)).toContain('completed')
    const kTurns = db
      .prepare(`SELECT * FROM k_thread_turns WHERE thread_id = ? AND role = 'k'`)
      .all(K_THREAD) as Array<Record<string, unknown>>
    expect(kTurns).toHaveLength(0)
  })
})

// ── org-role model capability warn-only (fix-a, lead choke-point) ─────────────

describe('drainLeadDispatches: warns (only) when a lead resolves to a haiku model (fix-a)', () => {
  it('a lead dispatched with a haiku-tier model triggers the warn-only org warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Pin lead-frontend to a haiku model (a lead dispatch passes no per-run model, so the
    // profile default is what startAgentRun resolves — same precedence the warn mirrors).
    db.prepare(`UPDATE agent_profiles SET default_model = ? WHERE id = 'lead-frontend'`).run('claude-haiku-4-5-20251001')
    try {
      recordIntent('RELAY-HAIKU-WARN')
      await drainLeadDispatches()
      const orgWarn = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('[org]') && m.includes('lead-frontend'))
      expect(orgWarn).toBeDefined()
      expect(orgWarn!).toContain('claude-haiku-4-5-20251001')
      expect(orgWarn!).toMatch(/deferred management tools/i)
    } finally {
      db.prepare(`UPDATE agent_profiles SET default_model = '' WHERE id = 'lead-frontend'`).run()
      warn.mockRestore()
    }
  })

  it('a lead dispatched with an opus/sonnet model triggers NO org warning; dispatch is unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.prepare(`UPDATE agent_profiles SET default_model = ? WHERE id = 'lead-frontend'`).run('claude-opus-4-8')
    try {
      const { assignmentId } = recordIntent('RELAY-OPUS-NOWARN')
      expect(await drainLeadDispatches()).toBe(1) // dispatch still happens (warn-only)
      expect(String(assignmentLeadRun(assignmentId))).toMatch(/^mock-relay-run-/)
      const orgWarn = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('[org]'))
      expect(orgWarn).toBeUndefined()
    } finally {
      db.prepare(`UPDATE agent_profiles SET default_model = '' WHERE id = 'lead-frontend'`).run()
      warn.mockRestore()
    }
  })
})

// ── 5. startLeadDispatchRelay wiring ─────────────────────────────────────────

describe('startLeadDispatchRelay', () => {
  it('returns a stop fn that is safe to call', () => {
    // A long interval so the timer never fires mid-test; stop() must not throw.
    const stop = startLeadDispatchRelay({ intervalMs: 60_000 })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('with LEAD_DISPATCH_RELAY=0 returns a no-op and wires no interval', () => {
    const prev = process.env.LEAD_DISPATCH_RELAY
    const spy = vi.spyOn(global, 'setInterval')
    process.env.LEAD_DISPATCH_RELAY = '0'
    try {
      const stop = startLeadDispatchRelay()
      expect(spy).not.toHaveBeenCalled()
      expect(() => stop()).not.toThrow()
    } finally {
      spy.mockRestore()
      if (prev === undefined) delete process.env.LEAD_DISPATCH_RELAY
      else process.env.LEAD_DISPATCH_RELAY = prev
    }
  })
})
