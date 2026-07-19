/**
 * agent-sessions.ts — the Lane A HYBRID LIVE PATH (Continuous Agents A.1).
 *
 * Locks the live-runtime behaviors the W0 interim adapter deliberately lacked:
 * interactive session spawns (persistent stdin), stdin delivery into a live
 * parked run (NO second spawn), the mid-turn pending queue drained at the next
 * awaiting_input boundary, INIT-time cli_session_id persistence, park → state
 * 'live' + context_tokens updates, and terminal detach with the W0-parity state
 * rules. The adapter test (agent-sessions-adapter.test.ts) keeps owning the
 * frozen-contract assertions (conversation/session rows, seed shape, errors).
 *
 * Mock harness mirrors the adapter test: '../src/supervisor.js' is partially
 * mocked — startRun INSERTS a real runs row (FK targets) + captures its args;
 * sendInput/endSession/kill are plain fns so stdin delivery is assertable
 * without a live process. Lifecycle is driven via eventBus.emitRunUpdate.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, agentSessionsDb, agentRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async (_prompt: string, opts?: { kind?: string; sessionId?: string }) => {
      const id = `mock-ca-live-${uuid().slice(0, 8)}`
      // A.3 (D-127): mirror the real insertRun's kind/session_id stamp from the
      // received opts, so the suite can assert the runs-row bookkeeping the spawn
      // threads through startAgentRun → startRun without launching a process.
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, kind, session_id, created_at) VALUES (?, 'ca', '.', 'queued', ?, ?, ?)`,
      ).run(id, opts?.kind ?? 'job', opts?.sessionId ?? null, Date.now())
      return { id }
    }),
    sendInput: vi.fn(() => true),
    endSession: vi.fn(() => true),
    kill: vi.fn(() => false),
  }
})

const { getOrCreateConversation, ensureSession, sendToSession, liveSessionCount, undoSessionRun } =
  await import('../src/agent-sessions.js')
const { listKThreadTurns } = await import('../src/k-thread.js')
const { kThreadsDb } = await import('../src/db.js')

type Row = Record<string, unknown>

/** The dedicated live-suite profile — never a seeded roster id, guard-created. */
const PROFILE = 'sess-live-prof-a'

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

/** Emit one run-lifecycle update the way the supervisor would (persists status too). */
const update = (id: string, status: Run['status'], extra: Partial<Run> = {}): void =>
  eventBus.emitRunUpdate({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0, ...extra } as Run)

function resetState() {
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare('DELETE FROM agent_runs WHERE profile_id = ?').run(PROFILE)
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-ca-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-ca-%'`).run()
}

// Guard-create the profile (k-thread.test.ts precedent: never seedProfiles() — the
// durable roster is a global invariant other tests assert on).
let createdProfile = false

beforeAll(() => {
  if (!getProfile(PROFILE)) {
    createProfile({ id: PROFILE, name: 'Live A', tier: 'orchestrator' })
    createdProfile = true
  }
})

beforeEach(() => {
  resetState()
  vi.mocked(startRun).mockClear()
  vi.mocked(sendInput).mockClear()
})

afterAll(() => {
  resetState()
  if (createdProfile) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(PROFILE)
})

/** A fresh conversation + session for the live profile, ready to send. */
function setup() {
  const t = getOrCreateConversation(PROFILE)
  const s = ensureSession(PROFILE, t.id)
  return { t, s }
}

describe('sendToSession — hybrid live path (A.1)', () => {
  it('spawn is INTERACTIVE + session-flagged, with the durable user turn linked', async () => {
    const { t, s } = setup()

    const r = await sendToSession(s.id, 'hello')
    expect(r.mode).toBe('spawned')

    const opts = lastStartRunOpts()
    expect(opts.interactive).toBe(true)
    const ps = lastPersistentSession()
    expect(ps).toMatchObject({ key: t.id, resume: false, homeDir: s.homeDir })
    expect(ps.sessionId).toMatch(/[0-9a-f-]{36}/)
    // A.3 (D-127): the spawn stamps the OWNING agent_sessions row — the sessionId
    // opt threads startAgentRun → startRun verbatim, and lands on runs.session_id
    // (with kind 'chat-turn' inferred from persistentSession along the way).
    expect(opts.sessionId).toBe(s.id)
    const runRow = db.prepare('SELECT kind, session_id FROM runs WHERE id = ?').get(r.runId) as Row
    expect(runRow.session_id).toBe(s.id)
    expect(runRow.kind).toBe('chat-turn')

    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('hello')
    expect(userTurns[0].runId).toBe(r.runId)
  })

  it("park → state 'live' + liveSessionCount", async () => {
    const { s } = setup()
    const r = await sendToSession(s.id, 'hello')

    update(r.runId, 'awaiting_input')

    expect(sessionRow(s.id)!.state).toBe('live')
    expect(liveSessionCount()).toBe(1)
  })

  it('a second message to a live parked session goes via stdin — NO second spawn', async () => {
    const { t, s } = setup()
    const r1 = await sendToSession(s.id, 'hello')
    update(r1.runId, 'awaiting_input')

    const r2 = await sendToSession(s.id, 'and another')

    expect(r2).toEqual({ mode: 'stdin', runId: r1.runId })
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendInput)).toHaveBeenCalledWith(r1.runId, 'and another')

    // The second durable user turn exists and is patched onto the LIVE run.
    // (Looked up by text, not index — same-ms turns tie-break by random uuid.)
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns).toHaveLength(2)
    const second = userTurns.find(x => x.text === 'and another')!
    expect(second).toBeDefined()
    expect(second.runId).toBe(r1.runId)
  })

  it('a mid-turn send queues and drains at the next awaiting_input boundary', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')

    // Mid-turn: the supervisor refuses stdin (run not parked) → the body queues.
    vi.mocked(sendInput).mockReturnValueOnce(false)
    const r2 = await sendToSession(s.id, 'queued body')
    expect(r2).toEqual({ mode: 'stdin', runId: r1.runId })
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendInput)).toHaveBeenCalledTimes(1)

    // Boundary: the queued body is retried into the same run.
    update(r1.runId, 'awaiting_input')
    expect(vi.mocked(sendInput)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendInput)).toHaveBeenLastCalledWith(r1.runId, 'queued body')
  })

  it('INIT persists cli_session_id immediately — not only at terminal', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')

    update(r1.runId, 'running', { cliSessionId: 'cli-abc' })

    const row = sessionRow(s.id)!
    expect(row.cli_session_id).toBe('cli-abc')
    // The run is still live — no terminal state transition happened.
    expect(row.state).toBe('stale')
  })

  it('a non-done terminal AFTER INIT keeps the session resumable with the INIT-persisted id (error-turn continuity)', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')

    update(r1.runId, 'running', { cliSessionId: 'cli-init-kept' })
    update(r1.runId, 'killed')

    const row = sessionRow(s.id)!
    expect(row.state).toBe('resumable')
    expect(row.cli_session_id).toBe('cli-init-kept')

    // Detached + resumable: the next send spawns a RESUME against the INIT id.
    const r2 = await sendToSession(s.id, 'again')
    expect(r2.mode).toBe('spawned')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2)
    expect(lastPersistentSession()).toMatchObject({ sessionId: 'cli-init-kept', resume: true })
  })

  it('captures the reply turn at an awaiting_input boundary (captureAnswers holds on the live path)', async () => {
    const { t, s } = setup()
    const r1 = await sendToSession(s.id, 'hello')

    eventBus.emitEvent({ id: uuid(), runId: r1.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'partial answer' })
    update(r1.runId, 'awaiting_input')

    const kTurns = listKThreadTurns(t.id).filter(x => x.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('partial answer')
  })

  it('updates context_tokens from the latest observed event at the park boundary', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')

    eventBus.emitEvent({ id: uuid(), runId: r1.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'x', contextTokens: 4321 })
    update(r1.runId, 'awaiting_input')

    expect(sessionRow(s.id)!.context_tokens).toBe(4321)
  })

  it("done → 'resumable' + attachment gone; the next send SPAWNS a resume", async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')
    const sid = lastPersistentSession().sessionId
    update(r1.runId, 'awaiting_input')

    // Proves the attachment is live: this send rides stdin.
    const r2 = await sendToSession(s.id, 'and another')
    expect(r2.mode).toBe('stdin')

    update(r1.runId, 'done')
    const row = sessionRow(s.id)!
    expect(row.state).toBe('resumable')
    expect(row.cli_session_id).toBe(sid)

    // Attachment detached at terminal → the third send spawns again, as a RESUME
    // carrying the bare body.
    const r3 = await sendToSession(s.id, 'a third message')
    expect(r3.mode).toBe('spawned')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2)
    expect(lastPersistentSession()).toMatchObject({ sessionId: sid, resume: true })
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toBe('a third message')
  })

  it('the establish send carries the neutral seed; the resume send carries the body only', async () => {
    const { t, s } = setup()
    // Backdated created_at: listTurns tie-breaks same-ms rows by random uuid, so
    // same-ms appendTurn history would scramble the seed order nondeterministically.
    const base = Date.now() - 10_000
    kThreadsDb.insertTurn.run({ id: uuid(), threadId: t.id, role: 'user', text: 'earlier question', runId: null, createdAt: base })
    kThreadsDb.insertTurn.run({ id: uuid(), threadId: t.id, role: 'k', text: 'earlier answer', runId: null, createdAt: base + 1_000 })

    const r1 = await sendToSession(s.id, 'hello')
    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(seed).toContain('You: earlier question')
    expect(seed).toContain('Agent: earlier answer')
    expect(seed).toContain('You: hello')
    expect(seed.endsWith('You: hello')).toBe(true)

    update(r1.runId, 'done')
    await sendToSession(s.id, 'next message')
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toBe('next message')
  })

  it("profile-send provenance — tagged turn, trigger 'delegation', raw-body seed", async () => {
    const { t, s } = setup()

    await sendToSession(s.id, 'ping', { from: { kind: 'profile', profileId: 'chief' } })

    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns[0].text).toBe('[from chief] ping')

    const runs = agentRunsDb.listRecentAgentRunsByProfile.all(PROFILE, 10) as Row[]
    expect(runs[0].trigger).toBe('delegation')

    // The dispatch seed carries the RAW body — provenance is turn-text only.
    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(seed).toContain('You: ping')
    expect(seed).not.toContain('[from chief]')
  })
})

// ── undoSessionRun (A.4) — the undo taint on the session engine ───────────────

describe('undoSessionRun (A.4)', () => {
  it('LIVE attachment: taints FIRST — stale + cleared id now, and a later terminal cannot resurrect resumable', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')
    update(r1.runId, 'running', { cliSessionId: 'cli-undo-live' })
    update(r1.runId, 'awaiting_input')
    expect(sessionRow(s.id)!.state).toBe('live')
    expect(sessionRow(s.id)!.cli_session_id).toBe('cli-undo-live')

    undoSessionRun(r1.runId)

    // Scrubbed immediately: the CLI context carries the undone message.
    expect(sessionRow(s.id)!.state).toBe('stale')
    expect(sessionRow(s.id)!.cli_session_id).toBeNull()

    // The killed run's LATE terminal consumes the taint and writes NOTHING.
    update(r1.runId, 'done')
    expect(sessionRow(s.id)!.state).toBe('stale')
    expect(sessionRow(s.id)!.cli_session_id).toBeNull()

    // Detached + stale → the next send re-ESTABLISHES from the durable turns.
    const r2 = await sendToSession(s.id, 'again')
    expect(r2.mode).toBe('spawned')
    expect(lastPersistentSession().resume).toBe(false)
  })

  it('DETACHED run: resolves the session via runs.session_id (A.3 stamp) and still scrubs', async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'hello')
    update(r1.runId, 'done') // establish stamp → resumable + id set, attachment gone
    expect(sessionRow(s.id)!.state).toBe('resumable')
    expect(sessionRow(s.id)!.cli_session_id).not.toBeNull()

    undoSessionRun(r1.runId)

    expect(sessionRow(s.id)!.state).toBe('stale')
    expect(sessionRow(s.id)!.cli_session_id).toBeNull()
  })

  it('an unknown / non-session run id is a silent no-op', () => {
    expect(() => undoSessionRun('no-such-run')).not.toThrow()
  })
})
