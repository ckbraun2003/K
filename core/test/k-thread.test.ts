/**
 * k-thread.ts — the K front-door runtime (P5.1c, D-023).
 *
 * Same supervisor-mock pattern as agent-runs.test.ts: startRun is mocked so no real
 * process spawns, but it INSERTS a real runs row (k_threads.active_run_id,
 * k_thread_turns.run_id and agent_runs.run_id all FK → runs(id)). sendInput and
 * __testHooks are kept REAL so the warm path exercises the true persistent-stdin
 * loop against a fake interactive proc. Isolated DB via vitest.config.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, runsDb, agentRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, __testHooks } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { mgmtTools } from '../src/mcp/mgmt.js'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real runs
// row (the K thread + agent_runs rows FK → runs(id)). sendInput / __testHooks stay
// REAL (spread ...actual) so the warm path uses the true machinery.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-k-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const {
  askK,
  ensureDefaultKThread,
  getKThread,
  listKThreadTurns,
  DEFAULT_K_THREAD_ID,
  continueLeadOutcomeToK,
  resolveKDelegationThread,
  summarizeChiefLeadContinuation,
} = await import('../src/k-thread.js')

function resetKState() {
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('k-secretary', 'chief')`).run()
  // mgmt reports the delegation report-back tests file against the mock chief run —
  // clear them before the runs (run_id → runs(id) ON DELETE SET NULL, but tidy anyway).
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id LIKE 'mock-k-%'`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%'`).run()
}

// Guard-create the 'k-secretary' (logistics/fresh path) + 'chief' (delegation path)
// profiles askK activates — do NOT call seedProfiles(): the durable roster is a global
// invariant profiles.test.ts asserts on a clean DB, so seeding all eight here would
// pollute that. Clean up only what we created (serial run — no cross-file race).
let createdKSecretary = false
let createdChief = false

beforeAll(() => {
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
  if (!getProfile('chief')) {
    createProfile({ id: 'chief', name: 'Chief', tier: 'chief' })
    createdChief = true
  }
})

beforeEach(() => {
  resetKState()
})

afterAll(() => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  if (createdChief) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
})

// ── routeForMessage (pure preview) ────────────────────────────────────────────

describe('routeForMessage', () => {
  // Re-import the pure helper straight from @k/shared (no DB / no mock needed).
  it('logistics — no engineering signal → K handles directly', async () => {
    const { routeForMessage } = await import('@k/shared')
    for (const msg of ['remind me to call mom', "what's on my calendar"]) {
      const r = routeForMessage(msg)
      expect(r.target).toBe('logistics')
      expect(r.escalates).toBe(false)
      expect(r.label).toBe('K handles directly')
    }
  })

  it('chief — generic engineering keyword, no named lead', async () => {
    const { routeForMessage } = await import('@k/shared')
    const r = routeForMessage('fix a failing test')
    expect(r.target).toBe('chief')
    expect(r.escalates).toBe(true)
    expect(r.label).toBe('Chief')
  })

  it('routes each named lead with its label + escalates=true', async () => {
    const { routeForMessage } = await import('@k/shared')
    const cases: Array<[string, string, string]> = [
      ['update the react component', 'frontend', 'Chief → Frontend Lead'],
      ['add an api endpoint', 'backend', 'Chief → Backend Lead'],
      ['fix the ci pipeline', 'systems', 'Chief → Systems Lead'],
      ['rotate the leaked credential', 'security', 'Chief → Security Lead'],
      ['debug the dns proxy', 'network', 'Chief → Network Lead'],
    ]
    for (const [msg, target, label] of cases) {
      const r = routeForMessage(msg)
      expect(r.target).toBe(target)
      expect(r.label).toBe(label)
      expect(r.escalates).toBe(true)
    }
  })
})

// ── askK — fresh (cold) dispatch ──────────────────────────────────────────────

describe('askK — fresh dispatch + answer capture', () => {
  it('starts a fresh interactive run, records the ask, captures K answers, clears on terminal', async () => {
    // A LOGISTICS message (no engineering signal) so K handles it itself on the fresh
    // path — an engineering ask now delegates to the Chief (see the delegation suite).
    const result = await askK('remind me to prep the meeting notes')

    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(result.kThreadId).toBe(DEFAULT_K_THREAD_ID)
    expect(typeof result.agentRunId).toBe('string')

    // A 'user' turn is recorded on the default thread, linked to the run.
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('remind me to prep the meeting notes')
    expect(userTurns[0].runId).toBe(result.runId)

    // The thread now points at the warm run.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBe(result.runId)

    // Two assistant events land, then a turn boundary (awaiting_input) — captureAnswers
    // should fold them into one 'k' turn.
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'Hello' })
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 2, type: 'assistant', ts: Date.now(), text: 'from K' })
    eventBus.emitRunUpdate({ id: result.runId, status: 'awaiting_input', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('Hello\nfrom K')
    expect(kTurns[0].runId).toBe(result.runId)

    // A terminal run_update clears the thread's active run (status → idle).
    eventBus.emitRunUpdate({ id: result.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const thread = getKThread(DEFAULT_K_THREAD_ID)!
    expect(thread.activeRunId).toBeNull()
    expect(thread.status).toBe('idle')
  })
})

// ── askK — warm (continue live run) ───────────────────────────────────────────

describe('askK — warm continuation', () => {
  it('feeds the turn into the live interactive run without starting a new one', async () => {
    // Arrange: a default thread whose active run is parked at awaiting_input, with a
    // fake interactive proc registered so sendInput can write the turn.
    ensureDefaultKThread()
    const warmRunId = `mock-k-warm-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'awaiting_input', ?)`,
    ).run(warmRunId, Date.now())
    db.prepare(`UPDATE k_threads SET active_run_id = ?, updated_at = ? WHERE id = ?`)
      .run(warmRunId, Date.now(), DEFAULT_K_THREAD_ID)
    __testHooks.initSeq(warmRunId)
    __testHooks.setActiveProc(warmRunId, { interactive: true, stdin: { write() {} }, kill() {} } as never)

    const startCallsBefore = vi.mocked(startRun).mock.calls.length

    const result = await askK('another message')

    expect(result.warm).toBe(true)
    expect(result.runId).toBe(warmRunId)
    expect(result.agentRunId).toBeNull()

    // No new run was started — the warm path never touches startRun.
    expect(vi.mocked(startRun).mock.calls.length).toBe(startCallsBefore)
    // sendInput actually claimed the parked turn (awaiting_input → running).
    expect(runsDb.getRun.get(warmRunId)).toMatchObject({ status: 'running' })

    // The user turn is recorded, linked to the warm run.
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('another message')
    expect(userTurns[0].runId).toBe(warmRunId)

    // Silence unused-import lint for sendInput (kept REAL and exercised via askK).
    expect(typeof sendInput).toBe('function')

    __testHooks.clearActiveProc(warmRunId)
  })
})

// ── askK — delegation to the Chief (D-046) ────────────────────────────────────

/** All chief agent_runs (newest first) on the shared DB. */
function chiefAgentRuns(): Array<Record<string, unknown>> {
  return agentRunsDb.listRecentAgentRunsByProfile.all('chief', 500) as Array<Record<string, unknown>>
}

/** File a mgmt report against `runId` exactly as the Chief's mgmt `report` tool does. */
function fileChiefReport(runId: string, body: string) {
  const report = mgmtTools.find(t => t.name === 'report')!
  return report.handler({ body }, { runId })
}

describe('askK — delegation to the Chief', () => {
  it('an engineering-routed ask dispatches the Chief with trigger=delegation (not a K run)', async () => {
    const result = await askK('fix the failing test suite')

    // The route escalated and the returned run is the Chief's delegated run.
    expect(result.route.target).toBe('chief')
    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(typeof result.agentRunId).toBe('string')

    // A chief agent_run exists with trigger 'delegation', linked to that run, carrying
    // the ask verbatim in its goal.
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger).toBe('delegation')
    expect(rows[0].run_id).toBe(result.runId)
    expect(String(rows[0].goal)).toContain('fix the failing test suite')

    // No k-secretary activation was created on the delegation path.
    expect(agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 500)).toHaveLength(0)

    // The thread carries the durable link: the user turn is linked to the Chief run
    // (parent→child, derivable via k_thread_turns.run_id + agent_runs.trigger), and an
    // acknowledgment 'k' turn names the route.
    const turns = listKThreadTurns(DEFAULT_K_THREAD_ID)
    const userTurn = turns.find(t => t.role === 'user')!
    expect(userTurn.text).toBe('fix the failing test suite')
    expect(userTurn.runId).toBe(result.runId)
    const ackTurn = turns.find(t => t.role === 'k')!
    expect(ackTurn.text).toContain('Routing to')
    expect(ackTurn.runId).toBe(result.runId)

    // Delegation does NOT hijack the thread's warm-session pointer.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBeNull()
  })

  it('routes a named-lead ask through the Chief with the discipline hinted in the goal', async () => {
    const result = await askK('update the react component styling')
    expect(result.route.target).toBe('frontend')

    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger).toBe('delegation')
    expect(String(rows[0].goal)).toContain('frontend')
    expect(String(rows[0].goal)).toContain('update the react component styling')
  })

  it("reports the Chief's mgmt report back onto K's thread when the delegated run terminates", async () => {
    const result = await askK('implement the new feature')
    const runId = result.runId

    // The Chief files a status report up the chain (the mgmt `report` tool), then its
    // run reaches terminal — the report-back seam folds the report onto K's thread.
    fileChiefReport(runId, 'PR #42 opened; CI green')
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    const reportBack = kTurns.find(t => t.text.includes('PR #42 opened'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text).toContain('completed')
    expect(reportBack!.runId).toBe(runId)

    // The delegated chief activation is finalized 'completed' by startAgentRun's own
    // lifecycle tracking on the same terminal event.
    const chiefRow = chiefAgentRuns()[0]
    expect(chiefRow.status).toBe('completed')
  })

  it('falls back to a bare status line when the Chief filed no report', async () => {
    const result = await askK('refactor the module')
    const runId = result.runId

    // No mgmt report, no assistant events — terminal with an error status.
    eventBus.emitRunUpdate({ id: runId, status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    const reportBack = kTurns.find(t => t.text.includes('no report was filed'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text).toContain('error')
  })

  it('a dispatch throw propagates and leaves the chief activation failed, no ack turn', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))

    await expect(askK('deploy the build')).rejects.toThrow('boom')

    // startAgentRun inserted the row 'running' then rolled it back to 'failed' + rethrew.
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].run_id).toBeNull()

    // The durable user turn stays (thread is source of truth); no 'k' ack turn was added.
    const turns = listKThreadTurns(DEFAULT_K_THREAD_ID)
    expect(turns.filter(t => t.role === 'user')).toHaveLength(1)
    expect(turns.filter(t => t.role === 'k')).toHaveLength(0)
  })
})

// ── Chief→K continuation — the lead outcome completes the up-chain (loop-b2) ───

/** Insert a real runs row + one assistant summary event (an FK-valid lead run). */
function seedLeadRun(id: string, summary: string, status = 'running'): void {
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'lead', '.', ?, ?)`,
  ).run(id, status, Date.now())
  db.prepare(
    `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'assistant', ?, ?)`,
  ).run(uuid(), id, Date.now(), summary)
}

const done = (id: string, status: Run['status'] = 'done'): Run =>
  ({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 }) as Run

describe('continueLeadOutcomeToK — the lead outcome completes the up-chain to K', () => {
  it('appends the lead outcome onto the delegating K thread on the LEAD terminal (once)', async () => {
    // A real K→Chief delegation links the Chief run to the K thread (the derivable edge).
    const { runId: chiefRunId } = await askK('implement the payment flow')
    expect(resolveKDelegationThread(chiefRunId)).toBe(DEFAULT_K_THREAD_ID)

    // The lead the Chief dispatched finishes AFTER the Chief's own turn could have ended.
    const leadRunId = `mock-k-run-lead-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Opened PR #7; CI green.')

    continueLeadOutcomeToK(chiefRunId, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    const cont = listKThreadTurns(DEFAULT_K_THREAD_ID)
      .filter(t => t.role === 'k')
      .find(t => t.text.includes('Opened PR #7'))
    expect(cont).toBeTruthy()
    expect(cont!.text).toContain('Chief (via lead-backend)')
    expect(cont!.text).toContain('completed')
    expect(cont!.runId).toBe(leadRunId) // linked to the lead run — part of the traceable chain

    // Fires ONCE: a duplicate terminal doesn't double-append (run-lifecycle latch).
    eventBus.emitRunUpdate(done(leadRunId))
    expect(
      listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.text.includes('Opened PR #7')),
    ).toHaveLength(1)
  })

  it('is a no-op when the Chief woke AUTONOMOUSLY (no K delegation linked)', () => {
    ensureDefaultKThread()
    // A Chief run with NO linked k_thread_turn (an autonomous wake) → no thread resolves.
    const autoChiefRun = `mock-k-run-auto-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'chief', '.', 'done', ?)`,
    ).run(autoChiefRun, Date.now())
    expect(resolveKDelegationThread(autoChiefRun)).toBeNull()

    const leadRunId = `mock-k-run-lead2-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Lead ran on an autonomous Chief wake.')

    continueLeadOutcomeToK(autoChiefRun, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    // No continuation turn landed — the outcome stays in the Chief's mgmt store only.
    expect(
      listKThreadTurns(DEFAULT_K_THREAD_ID).some(t =>
        t.text.includes('Lead ran on an autonomous Chief wake'),
      ),
    ).toBe(false)
  })

  it('summarizeChiefLeadContinuation prefers assistant text, else a bare status line', () => {
    const runId = `mock-k-run-sum-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'lead', '.', 'done', ?)`,
    ).run(runId, Date.now())
    // No assistant events yet → the bare fallback line.
    expect(summarizeChiefLeadContinuation(runId, 'lead-frontend', 'done')).toContain(
      'no summary was produced',
    )
    db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'assistant', ?, ?)`,
    ).run(uuid(), runId, Date.now(), 'Shipped the component.')
    const s = summarizeChiefLeadContinuation(runId, 'lead-frontend', 'error')
    expect(s).toContain('Chief (via lead-frontend) error') // non-'done' status surfaces verbatim
    expect(s).toContain('Shipped the component.')
  })
})
