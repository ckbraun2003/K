/**
 * agent-sessions.ts — DEMOTION LIFECYCLE + SEND SERIALIZATION (Continuous
 * Agents A.2, D-122).
 *
 * Locks the A.2 upgrades over the A.1 hybrid runtime:
 *  - idle config: parseSessionIdleMs / SESSION_IDLE_MS threaded to the spawn as
 *    the per-run awaiting_input idle override (supervisor `idleMs` opt);
 *  - demoteSession does REAL work: graceful endSession + immediate state flip
 *    ('idle'/'boot'/'lru' → 'resumable'; 'error' → forcedState taint + 'stale');
 *  - sweepLiveSessionsOnBoot reconciles rows stranded 'live' by a dead process;
 *  - LRU cap: spawning past maxLive() demotes the least-recently-updated live
 *    session first (listByState 'live' is updated_at DESC — the tail is oldest);
 *  - the FULL terminal rule set: resume-rejected (resume + no INIT + non-done)
 *    → 'stale' + cli_session_id CLEAR (replacing A.1's retry posture), INIT-seen
 *    continuity, forcedState override, and the pending-body re-dispatch that
 *    closes the A.1 documented PENDING STRAND;
 *  - per-session send serialization (withSessionSendLock) closing the W0/A.1
 *    double-establish race.
 *
 * Harness mirrors agent-sessions-live.test.ts exactly: '../src/supervisor.js'
 * partially mocked (startRun inserts a real runs row; sendInput/endSession/kill
 * plain fns), tables reset in beforeEach, guard-created profiles, lifecycle
 * driven via eventBus.emitRunUpdate.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, agentSessionsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, endSession } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { appendTurn } from '../src/k-thread.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-ca-dem-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'ca', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    sendInput: vi.fn(() => true),
    endSession: vi.fn(() => true),
    kill: vi.fn(() => false),
  }
})

const {
  getOrCreateConversation,
  ensureSession,
  sendToSession,
  demoteSession,
  liveSessionCount,
  parseSessionIdleMs,
  SESSION_IDLE_MS,
  sweepLiveSessionsOnBoot,
  __sessionTestHooks,
} = await import('../src/agent-sessions.js')

type Row = Record<string, unknown>

// Dedicated demote-suite profiles — never seeded roster ids, guard-created.
// Three because the LRU test needs three DISTINCT (profile, thread) sessions.
const PROFILE_A = 'sess-dem-prof-a'
const PROFILE_B = 'sess-dem-prof-b'
const PROFILE_C = 'sess-dem-prof-c'
const PROFILES = [PROFILE_A, PROFILE_B, PROFILE_C] as const

/** The raw agent_sessions row (snake_case) for direct persistence assertions. */
function sessionRow(id: string): Row | undefined {
  return agentSessionsDb.get.get(id) as Row | undefined
}

/** The opts object startRun was last called with (mocked). */
function lastStartRunOpts(): Record<string, unknown> {
  return vi.mocked(startRun).mock.calls.at(-1)![1] as Record<string, unknown>
}

/** The persistentSession opt threaded through startAgentRun → startRun. */
function lastPersistentSession(): { key: string; sessionId: string; resume: boolean; homeDir?: string } {
  return lastStartRunOpts().persistentSession as { key: string; sessionId: string; resume: boolean; homeDir?: string }
}

/** Emit one run-lifecycle update the way the supervisor would. */
const update = (id: string, status: Run['status'], extra: Partial<Run> = {}): void =>
  eventBus.emitRunUpdate({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0, ...extra } as Run)

function resetState() {
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('${PROFILES.join("', '")}')`).run()
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-ca-dem-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-ca-dem-%'`).run()
}

// Guard-create the profiles (k-thread.test.ts precedent: never seedProfiles()).
const createdProfiles: string[] = []

beforeAll(() => {
  for (const p of PROFILES) {
    if (!getProfile(p)) {
      createProfile({ id: p, name: `Demote ${p.slice(-1).toUpperCase()}`, tier: 'orchestrator' })
      createdProfiles.push(p)
    }
  }
})

beforeEach(() => {
  resetState()
  vi.mocked(startRun).mockClear()
  vi.mocked(sendInput).mockClear()
  vi.mocked(endSession).mockClear()
})

afterEach(() => {
  // The LRU test overrides the cap — always restore the frozen default.
  __sessionTestHooks.setMaxLive(null)
})

afterAll(() => {
  resetState()
  for (const p of createdProfiles) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(p)
})

/** A fresh conversation + session for a profile, ready to send. */
function setup(profileId: string) {
  const t = getOrCreateConversation(profileId)
  const s = ensureSession(profileId, t.id)
  return { t, s }
}

describe('A.2 — idle config', () => {
  it('parseSessionIdleMs guards NaN/zero/negative; the spawn threads idleMs: SESSION_IDLE_MS', async () => {
    expect(parseSessionIdleMs(undefined)).toBe(600_000)
    expect(parseSessionIdleMs('120000')).toBe(120_000)
    expect(parseSessionIdleMs('-5')).toBe(600_000)
    expect(parseSessionIdleMs('0')).toBe(600_000)
    expect(parseSessionIdleMs('x')).toBe(600_000)
    expect(SESSION_IDLE_MS).toBe(600_000) // K_SESSION_IDLE_MS is unset under vitest

    const { s } = setup(PROFILE_A)
    await sendToSession(s.id, 'hello')
    expect(lastStartRunOpts().idleMs).toBe(SESSION_IDLE_MS)
  })
})

describe('A.2 — demoteSession does real work', () => {
  it("'idle' on a live attached session ends the run gracefully + immediate 'resumable'; the later 'done' confirms", async () => {
    const { s } = setup(PROFILE_A)
    const r = await sendToSession(s.id, 'hello')
    update(r.runId, 'awaiting_input')
    expect(sessionRow(s.id)!.state).toBe('live')

    demoteSession(s.id, 'idle')
    expect(vi.mocked(endSession)).toHaveBeenCalledWith(r.runId)
    // Immediate flip — the UI must not show 'live' while the CLI winds down.
    expect(sessionRow(s.id)!.state).toBe('resumable')

    // The graceful stdin close lands 'done' later — finalize confirms, never regresses.
    update(r.runId, 'done')
    expect(sessionRow(s.id)!.state).toBe('resumable')
    expect(__sessionTestHooks.attachedRunId(s.id)).toBeUndefined()
  })

  it("'error' on a live session forces 'stale' NOW and at the run's later terminal (forcedState wins finalize)", async () => {
    const { s } = setup(PROFILE_A)
    const r = await sendToSession(s.id, 'hello')
    update(r.runId, 'awaiting_input')

    demoteSession(s.id, 'error')
    expect(vi.mocked(endSession)).toHaveBeenCalledWith(r.runId)
    expect(sessionRow(s.id)!.state).toBe('stale')

    // Even a clean 'done' cannot resurrect the session: the forcedState taint
    // wins the finalize, and the establish-stamp is skipped with it.
    update(r.runId, 'done')
    const row = sessionRow(s.id)!
    expect(row.state).toBe('stale')
    expect(row.cli_session_id).toBeNull()
    expect(__sessionTestHooks.attachedRunId(s.id)).toBeUndefined()
  })

  it("'error' demote clears a persisted cli_session_id — 'stale' really means reseed (quality m3)", async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    update(r1.runId, 'done') // establish stamps its id
    expect(sessionRow(s.id)!.cli_session_id).not.toBeNull()

    const r2 = await sendToSession(s.id, 'resume me')
    update(r2.runId, 'awaiting_input')
    demoteSession(s.id, 'error')

    // resume keys solely off cli_session_id — a retained id would silently
    // resume the errored CLI session on the next send, making 'stale' inert.
    let row = sessionRow(s.id)!
    expect(row.state).toBe('stale')
    expect(row.cli_session_id).toBeNull()

    update(r2.runId, 'done') // the wound-down run's terminal must not resurrect either
    row = sessionRow(s.id)!
    expect(row.state).toBe('stale')
    expect(row.cli_session_id).toBeNull()

    await sendToSession(s.id, 'fresh start')
    expect(lastPersistentSession().resume).toBe(false)
  })

  it("unknown-id demote is a silent no-op; 'idle'/'boot'/'lru' on a non-live unattached session is a no-op (W0 parity)", () => {
    expect(() => demoteSession('no-such-session', 'idle')).not.toThrow()
    expect(() => demoteSession('no-such-session', 'error')).not.toThrow()

    const { s } = setup(PROFILE_A) // born 'stale', no attachment
    for (const reason of ['idle', 'boot', 'lru'] as const) {
      demoteSession(s.id, reason)
      expect(sessionRow(s.id)!.state, `reason ${reason}`).toBe('stale')
    }
    agentSessionsDb.setState.run('resumable', Date.now(), s.id)
    demoteSession(s.id, 'boot')
    expect(sessionRow(s.id)!.state).toBe('resumable')
    expect(vi.mocked(endSession)).not.toHaveBeenCalled()
  })
})

describe('A.2 — boot sweep', () => {
  it("sweepLiveSessionsOnBoot flips ONLY 'live' rows to 'resumable' and returns the count", () => {
    const a = setup(PROFILE_A).s
    const b = setup(PROFILE_B).s
    const c = setup(PROFILE_C).s
    agentSessionsDb.setState.run('live', Date.now(), a.id)
    agentSessionsDb.setState.run('live', Date.now(), b.id)
    agentSessionsDb.setState.run('resumable', Date.now(), c.id)
    const cBefore = sessionRow(c.id)!.updated_at

    expect(sweepLiveSessionsOnBoot()).toBe(2)
    expect(sessionRow(a.id)!.state).toBe('resumable')
    expect(sessionRow(b.id)!.state).toBe('resumable')
    // The third row was already resumable — untouched, updated_at unchanged.
    expect(sessionRow(c.id)!.state).toBe('resumable')
    expect(sessionRow(c.id)!.updated_at).toBe(cBefore)

    // Idempotent: a second sweep finds nothing.
    expect(sweepLiveSessionsOnBoot()).toBe(0)
  })
})

describe('A.2 — LRU cap', () => {
  it('spawning past the cap demotes the least-recently-updated live session first', async () => {
    __sessionTestHooks.setMaxLive(2)
    const a = setup(PROFILE_A)
    const b = setup(PROFILE_B)
    const ra = await sendToSession(a.s.id, 'hi a')
    update(ra.runId, 'awaiting_input')
    const rb = await sendToSession(b.s.id, 'hi b')
    update(rb.runId, 'awaiting_input')
    expect(liveSessionCount()).toBe(2)

    // Touch A into the future so B is deterministically the least-recent live
    // session (listByState orders updated_at DESC; same-ms spawns would tie).
    agentSessionsDb.touch(a.s.id, Date.now() + 10_000)

    const c = setup(PROFILE_C)
    const rc = await sendToSession(c.s.id, 'hi c')

    expect(rc.mode).toBe('spawned')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(endSession)).toHaveBeenCalledWith(rb.runId)
    expect(vi.mocked(endSession)).not.toHaveBeenCalledWith(ra.runId)
    expect(sessionRow(b.s.id)!.state).toBe('resumable')
    expect(sessionRow(a.s.id)!.state).toBe('live')
    expect(liveSessionCount()).toBeLessThanOrEqual(2)
  })
})

describe('A.2 — full terminal rule set', () => {
  it("resume-rejected: a resume dying without INIT → 'stale' + cli_session_id CLEARED; the next send re-establishes with seed replay", async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'establish me')
    update(r1.runId, 'done')
    const sid = String(sessionRow(s.id)!.cli_session_id)
    expect(sid).toMatch(/[0-9a-f-]{36}/)

    const r2 = await sendToSession(s.id, 'resume me')
    expect(lastPersistentSession().resume).toBe(true)
    update(r2.runId, 'error') // NO cliSessionId was ever emitted on this attachment

    const row = sessionRow(s.id)!
    expect(row.state).toBe('stale')
    expect(row.cli_session_id).toBeNull() // the recorded CLI session is dead

    // Next send is an ESTABLISH: fresh id, full neutral-transcript reseed.
    await sendToSession(s.id, 'try again')
    const ps = lastPersistentSession()
    expect(ps.resume).toBe(false)
    expect(ps.sessionId).not.toBe(sid)
    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(seed).toContain('You: establish me')
    expect(seed.endsWith('You: try again')).toBe(true)
  })

  it("a resume dying AFTER INIT keeps continuity — 'resumable' with the INIT-persisted id", async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'establish me')
    update(r1.runId, 'done')

    const r2 = await sendToSession(s.id, 'resume me')
    expect(lastPersistentSession().resume).toBe(true)
    update(r2.runId, 'running', { cliSessionId: 'cli-x' })
    update(r2.runId, 'error')

    const row = sessionRow(s.id)!
    expect(row.state).toBe('resumable')
    expect(row.cli_session_id).toBe('cli-x')
  })

  it("an establish KILLED before INIT → 'stale', cli_session_id stays NULL", async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    update(r1.runId, 'killed')

    const row = sessionRow(s.id)!
    expect(row.state).toBe('stale')
    expect(row.cli_session_id).toBeNull()
  })

  it('bodies still pending at a non-killed terminal are re-dispatched in a fresh spawn (the A.1 strand is closed)', async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    vi.mocked(sendInput).mockReturnValueOnce(false) // mid-turn: the body queues
    const r2 = await sendToSession(s.id, 'stranded body')
    expect(r2).toEqual({ mode: 'stdin', runId: r1.runId })

    update(r1.runId, 'running', { cliSessionId: 'cli-live' }) // INIT observed
    update(r1.runId, 'error')

    // The re-dispatch rides the send lock (async) — wait for the second spawn.
    await vi.waitFor(() => expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2))
    // INIT was seen → the session stayed resumable → the re-dispatch RESUMES
    // with the queued body only.
    expect(lastPersistentSession()).toMatchObject({ resume: true, sessionId: 'cli-live' })
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toBe('stranded body')

    // Quality m1: the recovered body's durable turn is RE-POINTED to the
    // successor run — thread turn→run mapping stays honest for exactly the
    // messages the re-dispatch rescued.
    await vi.waitFor(() => expect(__sessionTestHooks.attachedRunId(s.id)).toBeDefined())
    const successor = __sessionTestHooks.attachedRunId(s.id)
    expect(successor).not.toBe(r1.runId)
    const turnRow = db.prepare(`SELECT run_id FROM k_thread_turns WHERE text = 'stranded body'`).get() as Row
    expect(turnRow.run_id).toBe(successor)
  })

  it('the re-dispatch establish seed excludes queued bodies BY TURN ID — no duplicate body when later turns trail them (spec S2)', async () => {
    const { t, s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    vi.mocked(sendInput).mockReturnValueOnce(false)
    await sendToSession(s.id, 'stranded body')
    // An assistant turn lands AFTER the queued body (captureAnswers folds the
    // dying run's text at the terminal) — positional trailing-slice math would
    // drop THIS turn instead of the body's and double the body in the seed.
    appendTurn(t.id, 'k', 'partial answer', r1.runId)

    update(r1.runId, 'error') // establish, no INIT → 'stale' → the re-dispatch re-establishes
    await vi.waitFor(() => expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2))

    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(seed.match(/You: stranded body/g)).toHaveLength(1)
    expect(seed).toContain('Agent: partial answer')
    expect(seed.endsWith('You: stranded body')).toBe(true)
  })

  it('bodies pending at a KILLED terminal are NOT auto re-dispatched (an operator kill is final)', async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    vi.mocked(sendInput).mockReturnValueOnce(false)
    await sendToSession(s.id, 'stranded body')

    update(r1.runId, 'killed')

    // Settle any (wrongly) queued re-dispatch before asserting the negative.
    await new Promise(r => setTimeout(r, 25))
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    // The durable turn survives — a later manual send replays it in its seed.
    expect(sessionRow(s.id)!.state).toBe('stale')
  })
})

describe('A.2 — per-session send serialization', () => {
  it('two unawaited concurrent sends produce ONE spawn; the second rides stdin into the same run', async () => {
    const { s } = setup(PROFILE_A)

    // Gate the first spawn on a manually-resolved promise so the second send
    // arrives while the first is still mid-dispatch (the W0 double-establish
    // window). Under the lock the second send must WAIT, then see the attachment.
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    vi.mocked(startRun).mockImplementationOnce((async () => {
      await gate
      const id = `mock-ca-dem-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'ca', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }) as never)

    const p1 = sendToSession(s.id, 'first')
    const p2 = sendToSession(s.id, 'second')
    release()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    expect(r1.mode).toBe('spawned')
    expect(r2).toEqual({ mode: 'stdin', runId: r1.runId })
    expect(vi.mocked(sendInput)).toHaveBeenCalledWith(r1.runId, 'second')
  })

  it('a send racing the terminal re-dispatch cold-spawns ONCE; the re-dispatch rides the successor via stdin (quality m2)', async () => {
    const { s } = setup(PROFILE_A)
    const r1 = await sendToSession(s.id, 'hello')
    vi.mocked(sendInput).mockReturnValueOnce(false)
    await sendToSession(s.id, 'stranded body')

    // Enqueue a user send in the SAME tick as the terminal: its lock job lands
    // BEFORE finalize enqueues the re-dispatch job, so it cold-spawns the
    // successor first — the re-dispatch must then ride that attachment instead
    // of double-spawning over it.
    const p = sendToSession(s.id, 'racer')
    update(r1.runId, 'error')
    const res = await p

    expect(res.mode).toBe('spawned')
    await vi.waitFor(() => expect(vi.mocked(sendInput)).toHaveBeenCalledWith(res.runId, 'stranded body'))
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2) // hello + racer — NO third spawn for the re-dispatch
    const turnRow = db.prepare(`SELECT run_id FROM k_thread_turns WHERE text = 'stranded body'`).get() as Row
    expect(turnRow.run_id).toBe(res.runId)
  })
})
