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
 *   e) the event path (onChiefWakeRunUpdate): the ORG-RELEVANCE filter (only a lead /
 *      delegation terminal wakes; bare runs and K-chat terminals do not), the
 *      self-wake guard, the kill switch (chief_wake_events_enabled), the rolling-hour
 *      rate breaker (chief_wake_max_per_hour, 'rate-capped'), the paid-loop cycle
 *      bound, and a working stop fn.
 *
 * Isolated DB via vitest.config.ts K_DATA_DIR; the suite leaves the shared core-test
 * DB as it found it (chief agent_runs + mock runs are its own; the chief/lead-backend/
 * k-secretary profiles are only removed if this suite created them).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb, configDb } from '../src/db.js'
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

/** Insert a chief agent_run row directly (for the already-running / self-wake /
 *  rate-breaker setups). trigger defaults to 'event' (the rate-breaker's subject). */
function insertChiefRun(opts: { goal: string; status: string; runId?: string | null; createdAt?: number }): string {
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
    createdAt: opts.createdAt ?? Date.now(),
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

/** Insert an agent_runs activation row for an arbitrary profile — the setup that
 *  makes a terminal run ORG-RELEVANT (a lead run / a delegation) or explicitly NOT
 *  (a K-chat 'user-message' run) for the event-path filter tests. */
function insertActivationRow(profileId: string, trigger: string, runId: string, status = 'completed'): void {
  agentRunsDb.insertAgentRun.run({
    id: uuid(),
    profileId,
    runId,
    trigger,
    goal: `activation for ${runId}`,
    projectId: null,
    workflowId: null,
    status,
    createdAt: Date.now(),
    completedAt: null,
  })
}

/** A fresh ORG-RELEVANT terminal: a runs row + a chief-dispatched lead activation
 *  (profile 'lead-backend', trigger 'delegation'). Returns the run id. */
function seedLeadTerminal(): string {
  const runId = `mock-cw-run-${uuid().slice(0, 8)}`
  insertRunRow(runId)
  insertActivationRow('lead-backend', 'delegation', runId)
  return runId
}

let createdChiefProfile = false
let createdLeadProfile = false
let createdKSecretaryProfile = false

beforeAll(() => {
  // startAgentRun('chief', …) resolves getProfile('chief'); the org-relevance filter
  // resolves the terminal run's owning profile ('lead-backend' orchestrator-tier =
  // relevant, 'k-secretary' = not). The shared DB may already carry seeded rows from
  // another suite — only create what is absent, and only remove what we created.
  if (!getProfile('chief')) {
    createProfile({ id: 'chief', name: 'Chief', tier: 'chief' })
    createdChiefProfile = true
  }
  if (!getProfile('lead-backend')) {
    createProfile({ id: 'lead-backend', name: 'Backend', tier: 'orchestrator' })
    createdLeadProfile = true
  }
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretaryProfile = true
  }
})

// Clean slate before every case: no chief agent_runs (Guard B + the rate breaker are
// global per-profile checks, so a leaked row would poison later wakes), no leftover
// activation rows on our mock runs, + a reset debounce clock.
beforeEach(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-cw-run-%'`).run()
  resetChiefWakeDebounce()
})

afterAll(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-cw-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-cw-run-%'`).run()
  db.prepare(`DELETE FROM app_config WHERE key IN ('chief_wake_events_enabled', 'chief_wake_max_per_hour')`).run()
  if (createdChiefProfile) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
  if (createdLeadProfile) db.prepare(`DELETE FROM agent_profiles WHERE id = 'lead-backend'`).run()
  if (createdKSecretaryProfile) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
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

  it('f) F-089: a successful wake logs ONE observability line; a debounced tick does not', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const T = Date.now()
      const first = await wakeChief('schedule', { goal: 'p89-log', now: T })
      expect(first.woke).toBe(true)
      if (!first.woke) throw new Error('expected woke')

      // The success PASS logged exactly one `[chief-wake] woke chief` line naming the
      // trigger + resulting run id.
      const wokeLines = logSpy.mock.calls
        .map(c => String(c[0]))
        .filter(l => l.includes('[chief-wake] woke chief'))
      expect(wokeLines).toHaveLength(1)
      expect(wokeLines[0]).toContain('trigger=schedule')
      expect(wokeLines[0]).toContain(first.runId)

      // A debounced tick inside the same window logs NO "woke" line.
      logSpy.mockClear()
      const second = await wakeChief('schedule', { goal: 'p89-log-2', now: T })
      expect(second.woke).toBe(false)
      expect(logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('woke chief'))).toHaveLength(0)
    } finally {
      logSpy.mockRestore()
    }
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
  it('e1) org-relevance filter: a bare terminal run does NOT wake; a chief-dispatched lead terminal DOES (trigger=event)', async () => {
    // A bare run (no agent_runs row at all — an eval / skill / manual run) is not
    // org-relevant: no wake.
    const bareRunId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(bareRunId)
    onChiefWakeRunUpdate(terminalRun(bareRunId))
    await flush()
    expect(chiefWakesGoalIncludes(bareRunId)).toHaveLength(0)

    // An org-relevant terminal — a lead activation (orchestrator tier, dispatched
    // via delegation) — wakes the Chief with trigger=event.
    const leadRunId = seedLeadTerminal()
    onChiefWakeRunUpdate(terminalRun(leadRunId))
    await flush()

    const woke = chiefWakesGoalIncludes(leadRunId)
    expect(woke).toHaveLength(1)
    expect(woke[0].trigger).toBe('event')
  })

  it('e1b) a K-chat terminal (k-secretary / user-message) does NOT wake', async () => {
    const kRunId = `mock-cw-run-${uuid().slice(0, 8)}`
    insertRunRow(kRunId)
    insertActivationRow('k-secretary', 'user-message', kRunId)

    onChiefWakeRunUpdate(terminalRun(kRunId))
    await flush()

    expect(chiefWakesGoalIncludes(kRunId)).toHaveLength(0)
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
    // While subscribed: an ORG-RELEVANT terminal run emitted on the bus wakes the
    // chief (a bare run would now be filtered — see e1).
    const stop = startChiefWake()
    const liveId = seedLeadTerminal()
    eventBus.emitRunUpdate(terminalRun(liveId))
    await flush()
    expect(chiefWakesGoalIncludes(liveId)).toHaveLength(1)

    // After stop(): a later emit produces no wake — even an org-relevant one, so the
    // unsubscribe (not the relevance filter) is what blocks it.
    stop()
    db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief'`).run()
    resetChiefWakeDebounce()
    const afterStopId = seedLeadTerminal()
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

  it('e7) kill switch: chief_wake_events_enabled=0 gates the event path only (cron wakes still fire)', async () => {
    try {
      configDb.set('chief_wake_events_enabled', '0')

      // An org-relevant terminal that would normally wake — the switch blocks it.
      const leadRunId = seedLeadTerminal()
      onChiefWakeRunUpdate(terminalRun(leadRunId))
      await flush()
      expect(chiefWakesGoalIncludes(leadRunId)).toHaveLength(0)

      // The cron path is unaffected by the event kill switch.
      scheduledChiefWake()
      await flush()
      expect(chiefWakesWithGoal(DEFAULT_CHIEF_WAKE_GOAL)).toHaveLength(1)
    } finally {
      db.prepare(`DELETE FROM app_config WHERE key = 'chief_wake_events_enabled'`).run()
    }
  })

  it('e8) rate breaker: event wakes beyond chief_wake_max_per_hour are rate-capped (schedule wakes exempt)', async () => {
    // Default cap = 6. Seed exactly 6 chief 'event' activations inside the rolling
    // hour, then attempt a 7th event wake with the debounce reset and `now` well past
    // the debounce window — the BREAKER (not Guard A/B) must be the decider.
    for (let i = 0; i < 6; i++) insertChiefRun({ goal: `p52b-cap-seed-${i}`, status: 'completed' })
    resetChiefWakeDebounce()

    const res = await wakeChief('event', { goal: 'p52b-capped', now: Date.now() + 10 * 60_000 })
    expect(res.woke).toBe(false)
    if (!res.woke) expect(res.reason).toBe('rate-capped')
    // A skipped wake creates NO ledger row.
    expect(chiefWakesWithGoal('p52b-capped')).toHaveLength(0)

    // Cron/schedule wakes are NOT subject to the cap.
    const sched = await wakeChief('schedule', { goal: 'p52b-cap-sched', now: Date.now() + 20 * 60_000 })
    expect(sched.woke).toBe(true)
    expect(chiefWakesWithGoal('p52b-cap-sched')).toHaveLength(1)
  })

  it('e9) the paid loop is bounded: a wake→dispatch→lead-terminal→wake cycle stops at the cap', async () => {
    try {
      configDb.set('chief_wake_max_per_hour', '2')

      // Simulate the live cycle 3×: a chief-dispatched lead reaches terminal, the
      // event path re-wakes the Chief, the chief run completes (so Guard B passes),
      // the debounce resets. Only the CAP can stop this loop — and it must, at 2.
      for (let i = 0; i < 3; i++) {
        const leadRunId = seedLeadTerminal()
        onChiefWakeRunUpdate(terminalRun(leadRunId))
        await flush()
        // Complete the created chief activation directly so Guard B never interferes.
        db.prepare(`UPDATE agent_runs SET status = 'completed' WHERE profile_id = 'chief' AND status = 'running'`).run()
        resetChiefWakeDebounce()
      }

      const eventWakes = chiefWakes().filter(r => r.trigger === 'event')
      expect(eventWakes).toHaveLength(2) // the 3rd wake was suppressed by the breaker
    } finally {
      db.prepare(`DELETE FROM app_config WHERE key = 'chief_wake_max_per_hour'`).run()
    }
  })
})

// ── org-role model capability warn-only (fix-a, Chief choke-point) ────────────

describe('wakeChief: warns (only) when the Chief resolves to a haiku model (fix-a)', () => {
  it('a Chief dispatched with a haiku-tier model triggers the warn-only org warning; still dispatches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Clear any lingering running chief run (Guard B) + reset debounce so this wake PASSES.
    db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief' AND status = 'running'`).run()
    resetChiefWakeDebounce()
    db.prepare(`UPDATE agent_profiles SET default_model = ? WHERE id = 'chief'`).run('claude-haiku-4-5-20251001')
    try {
      const res = await wakeChief('schedule', { goal: 'fixa-chief-haiku', now: Date.now() + 3 * 60 * 60_000 })
      expect(res.woke).toBe(true) // warn-only: the dispatch still happens
      const orgWarn = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('[org]') && m.includes('Chief'))
      expect(orgWarn).toBeDefined()
      expect(orgWarn!).toContain('claude-haiku-4-5-20251001')
      expect(orgWarn!).toMatch(/deferred management tools/i)
      if (res.woke) eventBus.emitRunUpdate(terminalRun(res.runId)) // finalize so no running row leaks
    } finally {
      db.prepare(`UPDATE agent_profiles SET default_model = '' WHERE id = 'chief'`).run()
      warn.mockRestore()
    }
  })

  it('a Chief dispatched with a sonnet model triggers NO org warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'chief' AND status = 'running'`).run()
    resetChiefWakeDebounce()
    db.prepare(`UPDATE agent_profiles SET default_model = ? WHERE id = 'chief'`).run('claude-sonnet-4-6')
    try {
      const res = await wakeChief('schedule', { goal: 'fixa-chief-sonnet', now: Date.now() + 6 * 60 * 60_000 })
      expect(res.woke).toBe(true)
      const orgWarn = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('[org]'))
      expect(orgWarn).toBeUndefined()
      if (res.woke) eventBus.emitRunUpdate(terminalRun(res.runId))
    } finally {
      db.prepare(`UPDATE agent_profiles SET default_model = '' WHERE id = 'chief'`).run()
      warn.mockRestore()
    }
  })
})
