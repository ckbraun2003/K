/**
 * chief-wake.ts — the Chief autonomous wake loop (P5.2b).
 *
 * Design D-044: a "Chief wake" IS an `agent_runs` row (profile_id='chief',
 * trigger ∈ {schedule,event}) created via `startAgentRun('chief', …)` — no new
 * table. So these tests assert against `agentRunsDb`, exactly like the chief route
 * reads. `supervisor.startRun` is mocked (same pattern as agent-runs.test.ts) so no
 * real dispatch happens; the mock inserts a real `runs` row because
 * `agent_runs.run_id` has a FOREIGN KEY → runs(id).
 *
 * Covered:
 *   a) schedule tick → running chief wake → finalizes 'completed' on terminal run_update
 *   b) a synchronous burst debounces to ONE wake (rest 'debounced')
 *   c) an already-running chief run blocks a fresh wake ('already-running')
 *   d) a dispatch failure degrades to {woke:false,reason:'failed'} (NO throw), row 'failed'
 *   e) the event path (onChiefWakeRunUpdate) + the self-wake guard + a working stop fn
 *
 * Isolated DB via vitest.config.ts K_DATA_DIR; the suite leaves the shared core-test
 * DB as it found it (chief agent_runs + mock runs are its own; the chief profile is
 * only removed if this suite created it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { getProfile, createProfile } from '../src/profiles.js'
import type { Run } from '@k/shared'

// startRun mocked so no real agent spawns, but it MUST insert a real runs row:
// agent_runs.run_id has a FOREIGN KEY → runs(id). Mirrors agent-runs.test.ts.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-cw-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'cw', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Import the module under test AFTER the mock is registered.
const {
  wakeChief,
  resetChiefWakeDebounce,
  onChiefWakeRunUpdate,
  scheduledChiefWake,
  startChiefWake,
  DEFAULT_CHIEF_WAKE_GOAL,
} = await import('../src/chief-wake.js')

// ── helpers ──────────────────────────────────────────────────────────────────

/** Let a fire-and-forget wakeChief() settle (mock startRun is async). */
const flush = () => new Promise(r => setTimeout(r, 30))

/** A terminal Run event for `id` (minimal shape the handlers read). */
function terminalRun(id: string, status: Run['status'] = 'done'): Run {
  return { id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run
}

/** All chief agent_runs (newest first). */
function chiefWakes(): Array<Record<string, unknown>> {
  return agentRunsDb.listRecentAgentRunsByProfile.all('chief', 500) as Array<Record<string, unknown>>
}
function chiefWakesWithGoal(goal: string): Array<Record<string, unknown>> {
  return chiefWakes().filter(r => r.goal === goal)
}
function chiefWakesGoalIncludes(sub: string): Array<Record<string, unknown>> {
  return chiefWakes().filter(r => typeof r.goal === 'string' && (r.goal as string).includes(sub))
}

/** Insert a chief agent_run row directly (for the already-running / self-wake setups). */
function insertChiefRun(opts: { goal: string; status: string; runId?: string | null }): string {
  const id = uuid()
  agentRunsDb.insertAgentRun.run({
    id,
    profileId: 'chief',
    runId: opts.runId ?? null,
    trigger: 'event',
    goal: opts.goal,
    projectId: null,
    workflowId: null,
    status: opts.status,
    createdAt: Date.now(),
    completedAt: null,
  })
  return id
}

/** Insert a real runs row so an FK-bound agent_run / event has a target. */
function insertRunRow(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'cw', '.', 'queued', ?)`,
  ).run(id, Date.now())
}

let createdChiefProfile = false

beforeAll(() => {
  // startAgentRun('chief', …) resolves getProfile('chief'); the shared DB may
  // already carry a seeded 'chief' from another suite — only create it if absent,
  // and only remove it in afterAll if we created it.
  if (!getProfile('chief')) {
    createProfile({ id: 'chief', name: 'Chief', tier: 'chief' })
    createdChiefProfile = true
  }
})

// Clean slate before every case: no chief agent_runs (Guard B is a global
// per-profile check, so a leaked 'running' row would poison later wakes) + a
// reset debounce clock. Only chief rows are ours — no other suite creates them.
beforeEach(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
  resetChiefWakeDebounce()
})

afterAll(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-cw-run-%'`).run()
  if (createdChiefProfile) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
})

describe('wakeChief', () => {
  it('a) schedule tick creates a running chief wake, then finalizes on a terminal run_update', async () => {
    const res = await wakeChief('schedule', { goal: 'p52b-sched' })
    expect(res.woke).toBe(true)
    if (!res.woke) throw new Error('expected woke')
    expect(typeof res.agentRunId).toBe('string')
    expect(res.runId).toMatch(/^mock-cw-run-/)

    const row = agentRunsDb.getAgentRun.get(res.agentRunId) as Record<string, unknown>
    expect(row.profile_id).toBe('chief')
    expect(row.trigger).toBe('schedule')
    expect(row.goal).toBe('p52b-sched')
    expect(row.status).toBe('running')
    expect(row.run_id).toBe(res.runId)

    // Drive the live finalize path (run-lifecycle seam) via a terminal run_update.
    eventBus.emitRunUpdate(terminalRun(res.runId))
    const after = agentRunsDb.getAgentRun.get(res.agentRunId) as { status: string; completed_at: number | null }
    expect(after.status).toBe('completed')
    expect(after.completed_at).not.toBeNull()
  })

  it('b) debounces a synchronous burst to exactly ONE wake', async () => {
    const T = Date.now()
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(await wakeChief('schedule', { goal: 'p52b-burst', now: T }))

    expect(outcomes[0].woke).toBe(true)
    for (let i = 1; i < 5; i++) {
      expect(outcomes[i].woke).toBe(false)
      if (!outcomes[i].woke) expect((outcomes[i] as { reason: string }).reason).toBe('debounced')
    }
    expect(chiefWakesWithGoal('p52b-burst')).toHaveLength(1)
  })

  it('c) skips a fresh wake while a chief run is already running (guard B, not debounce)', async () => {
    // A chief run left 'running'; debounce is reset + `now` is far past the window,
    // so the already-running guard is what blocks it.
    insertChiefRun({ goal: 'p52b-guard-blocker', status: 'running' })
    const res = await wakeChief('schedule', { goal: 'p52b-guard', now: Date.now() + 10 * 60_000 })

    expect(res.woke).toBe(false)
    if (!res.woke) expect(res.reason).toBe('already-running')
    expect(chiefWakesWithGoal('p52b-guard')).toHaveLength(0)
  })

  it('d) a dispatch failure degrades to {woke:false,reason:failed} without throwing, row left failed', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))

    const res = await wakeChief('schedule', { goal: 'p52b-fail', now: Date.now() + 20 * 60_000 })
    expect(res.woke).toBe(false)
    if (!res.woke) expect(res.reason).toBe('failed')

    // startAgentRun inserted the row 'running', then rolled it back to 'failed' + rethrew;
    // wakeChief swallowed the throw. The row is 'failed' with no runId, none left 'running'.
    const rows = chiefWakesWithGoal('p52b-fail')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].run_id).toBeNull()
    expect(chiefWakes().some(r => r.status === 'running')).toBe(false)
  })

  it('returns {reason:disabled} when CHIEF_WAKE=0', async () => {
    const prev = process.env.CHIEF_WAKE
    process.env.CHIEF_WAKE = '0'
    try {
      const res = await wakeChief('schedule', { goal: 'p52b-disabled' })
      expect(res.woke).toBe(false)
      if (!res.woke) expect(res.reason).toBe('disabled')
      expect(chiefWakesWithGoal('p52b-disabled')).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.CHIEF_WAKE
      else process.env.CHIEF_WAKE = prev
    }
  })
})

describe('onChiefWakeRunUpdate (event path) + startChiefWake', () => {
  it('e1) a non-chief terminal run_update wakes the Chief with trigger=event', async () => {
    const runId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(runId)

    onChiefWakeRunUpdate(terminalRun(runId))
    await flush()

    const woke = chiefWakesGoalIncludes(runId)
    expect(woke).toHaveLength(1)
    expect(woke[0].trigger).toBe('event')
  })

  it('e2) self-wake guard: a CHIEF run finishing does NOT wake the Chief', async () => {
    // A completed chief agent_run whose run finishing must NOT re-wake the chief
    // (else wake→run→complete→wake loops). Status 'completed' so guard B would PASS —
    // the self-wake guard is the decider.
    const chiefRunId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(chiefRunId)
    insertChiefRun({ goal: 'p52b-own', status: 'completed', runId: chiefRunId })

    onChiefWakeRunUpdate(terminalRun(chiefRunId))
    await flush()

    // No NEW event-trigger wake naming that run id.
    expect(chiefWakesGoalIncludes(chiefRunId)).toHaveLength(0)
  })

  it('e3) a non-terminal run_update does not wake', async () => {
    const runId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(runId)

    onChiefWakeRunUpdate(terminalRun(runId, 'running'))
    await flush()

    expect(chiefWakesGoalIncludes(runId)).toHaveLength(0)
  })

  it('e4) startChiefWake subscribes while live and its stop fn unsubscribes', async () => {
    // While subscribed: a non-chief terminal run emitted on the bus wakes the chief.
    const stop = startChiefWake()
    const liveId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(liveId)
    eventBus.emitRunUpdate(terminalRun(liveId))
    await flush()
    expect(chiefWakesGoalIncludes(liveId)).toHaveLength(1)

    // After stop(): a later emit produces no wake.
    stop()
    db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
    resetChiefWakeDebounce()
    const afterStopId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(afterStopId)
    eventBus.emitRunUpdate(terminalRun(afterStopId))
    await flush()
    expect(chiefWakesGoalIncludes(afterStopId)).toHaveLength(0)
  })

  it('e5) DEFAULT_CHIEF_WAKE_GOAL is a non-empty instruction', () => {
    expect(typeof DEFAULT_CHIEF_WAKE_GOAL).toBe('string')
    expect(DEFAULT_CHIEF_WAKE_GOAL.length).toBeGreaterThan(0)
  })

  it('e6) scheduledChiefWake (the cron-tick body) fires a schedule-trigger chief wake', async () => {
    // This is the EXACT callback the cron task runs — proving the "a scheduler tick
    // calls startAgentRun('chief', {trigger:schedule})" seam without cron timing.
    scheduledChiefWake()
    await flush()

    const woke = chiefWakesWithGoal(DEFAULT_CHIEF_WAKE_GOAL)
    expect(woke).toHaveLength(1)
    expect(woke[0].trigger).toBe('schedule')
  })
})
