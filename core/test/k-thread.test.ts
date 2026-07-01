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
import { db, runsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, __testHooks } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'

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
} = await import('../src/k-thread.js')

function resetKState() {
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'k-secretary'`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%'`).run()
}

// Guard-create only the 'k-secretary' profile askK activates — do NOT call
// seedProfiles(): the durable roster is a global invariant profiles.test.ts asserts
// on a clean DB, so seeding all eight here would pollute that. Clean up if we made it.
let createdKSecretary = false

beforeAll(() => {
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
})

beforeEach(() => {
  resetKState()
})

afterAll(() => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
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
    const result = await askK('build the backend api')

    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(result.kThreadId).toBe(DEFAULT_K_THREAD_ID)
    expect(typeof result.agentRunId).toBe('string')

    // A 'user' turn is recorded on the default thread, linked to the run.
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('build the backend api')
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
