/**
 * agent-sessions.ts — the W0.3 FROZEN session-engine contract (Continuous
 * Agents, D-122), asserted over the Lane A hybrid runtime. Locks conversation/
 * session row lifecycle, the cold-send (spawn) path's persistentSession shape +
 * seed rendering, terminal state rules, and the K-path supervisor selection.
 * The LIVE-path behaviors (stdin delivery, pending queue, INIT persist, park →
 * 'live') are owned by agent-sessions-live.test.ts.
 *
 * Two mock layers, both house patterns:
 *  - '../src/supervisor.js' startRun is mocked (the k-thread.test.ts pattern) so the
 *    adapter tests dispatch no real process, but it INSERTS a real runs row (the
 *    thread/turn/agent_runs FKs → runs(id)) and captures its call args so tests can
 *    assert the persistentSession shape the adapter threads through.
 *  - '../src/agent-config.js' synthesizeConfigDir throws (the
 *    carry-persistent-session.test.ts pattern) so the K-path regression guard can run
 *    the REAL startRun — proving the supervisor's homeDir/kSecretaryConfigPaths path
 *    selection — with runAgent aborting before any claude spawn. agentSessionPaths /
 *    kSecretaryConfigPaths stay real (…actual spread).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, agentSessionsDb, agentRunsDb, kThreadsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-ca-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'ca', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Abort the REAL startRun's runAgent before any spawn (K-path guard below); every
// other agent-config export — agentSessionPaths, kSecretaryConfigPaths — stays real.
vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('ca-adapter-wiring-stop') }) }
})

const {
  getOrCreateConversation,
  ensureSession,
  sendToSession,
  demoteSession,
  liveSessionCount,
  MAX_LIVE_SESSIONS,
  parseMaxLiveSessions,
  AgentSessionNotFoundError,
} = await import('../src/agent-sessions.js')
const { agentSessionPaths, kSecretaryConfigPaths } = await import('../src/agent-config.js')
const { DEFAULT_K_THREAD_ID, appendTurn, listKThreadTurns, getKThread } = await import('../src/k-thread.js')

type Row = Record<string, unknown>

/** The raw agent_sessions row (snake_case) for direct persistence assertions. */
function sessionRow(id: string): Row | undefined {
  return agentSessionsDb.get.get(id) as Row | undefined
}

/** The opts object startRun was last called with (mocked). */
function lastStartRunOpts(): Record<string, unknown> {
  return vi.mocked(startRun).mock.calls.at(-1)![1] as Record<string, unknown>
}

/** The persistentSession opt the adapter last threaded through startAgentRun → startRun. */
function lastPersistentSession(): { key: string; sessionId: string; resume: boolean; homeDir?: string } {
  return lastStartRunOpts().persistentSession as { key: string; sessionId: string; resume: boolean; homeDir?: string }
}

const terminal = (id: string, status: Run['status'] = 'done'): Run =>
  ({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 }) as Run

function resetState() {
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('k-secretary', 'chief')`).run()
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-ca-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-ca-%'`).run()
}

// Guard-create the profiles the adapter activates (k-thread.test.ts precedent: never
// seedProfiles() — the durable roster is a global invariant other tests assert on).
let createdKSecretary = false
let createdChief = false
const realRunIds: string[] = []
const tmpDirs: string[] = []

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
  resetState()
  vi.mocked(startRun).mockClear()
})

afterAll(() => {
  resetState()
  for (const id of realRunIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  if (createdChief) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
})

// ── getOrCreateConversation ───────────────────────────────────────────────────

describe('getOrCreateConversation — one conversation per profile', () => {
  it('k-secretary resolves to the default K thread (K callers pass threads explicitly)', () => {
    const t = getOrCreateConversation('k-secretary')
    expect(t.id).toBe(DEFAULT_K_THREAD_ID)
    expect(getOrCreateConversation('k-secretary').id).toBe(DEFAULT_K_THREAD_ID)
  })

  it('creates exactly ONE thread per profile, profile_id stamped; the second call returns the same id', () => {
    const first = getOrCreateConversation('chief')
    expect(first.title).toBeNull()
    expect(first.status).toBe('active')
    // The id must be a safe path segment — it keys agentSessionPaths later.
    expect(first.id).toMatch(/^[a-z0-9-]+$/i)

    const row = db.prepare('SELECT profile_id FROM k_threads WHERE id = ?').get(first.id) as Row
    expect(row.profile_id).toBe('chief')

    const second = getOrCreateConversation('chief')
    expect(second.id).toBe(first.id)
    const count = db.prepare(`SELECT COUNT(*) AS n FROM k_threads WHERE profile_id = 'chief'`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('rejects a path-unsafe profile id before touching the DB', () => {
    expect(() => getOrCreateConversation('../evil')).toThrow(/unsafe/)
    const count = db.prepare('SELECT COUNT(*) AS n FROM k_threads').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

// ── ensureSession ─────────────────────────────────────────────────────────────

describe('ensureSession — row lifecycle', () => {
  it("creates the row 'stale' with a STABLE home_dir = agentSessionPaths base", () => {
    const t = getOrCreateConversation('chief')
    const s = ensureSession('chief', t.id)

    expect(s.profileId).toBe('chief')
    expect(s.threadId).toBe(t.id)
    expect(s.state).toBe('stale')
    expect(s.cliSessionId).toBeNull()
    expect(s.contextTokens).toBeNull()
    expect(s.homeDir).toBe(agentSessionPaths('chief', t.id).base)

    // Stable across calls: same row id, same created_at, same home_dir — one row only.
    const again = ensureSession('chief', t.id)
    expect(again.id).toBe(s.id)
    expect(again.createdAt).toBe(s.createdAt)
    expect(again.homeDir).toBe(s.homeDir)
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('preserves cli_session_id and state across upserts (the refresh path)', () => {
    const t = getOrCreateConversation('chief')
    const s = ensureSession('chief', t.id)
    agentSessionsDb.setCliSessionId.run('cli-abc', Date.now(), s.id)
    agentSessionsDb.setState.run('resumable', Date.now(), s.id)

    const again = ensureSession('chief', t.id)
    expect(again.cliSessionId).toBe('cli-abc')
    expect(again.state).toBe('resumable')
  })
})

// ── sendToSession ─────────────────────────────────────────────────────────────

describe('sendToSession — frozen contract (cold-path resumable sends)', () => {
  /** A fresh chief conversation + session, ready to send. */
  function setup() {
    const t = getOrCreateConversation('chief')
    const s = ensureSession('chief', t.id)
    return { t, s }
  }

  it('throws the typed error for an unknown session id', async () => {
    await expect(sendToSession('no-such-session', 'hi')).rejects.toThrow(AgentSessionNotFoundError)
  })

  it('round-trip: establish → done stamps cli_session_id + resumable; a second send resumes with body-only seed', async () => {
    const { t, s } = setup()

    const r1 = await sendToSession(s.id, 'hello world')
    expect(r1.mode).toBe('spawned')

    // Durable user turn first, patched onto the run once dispatched.
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('hello world')
    expect(userTurns[0].runId).toBe(r1.runId)
    expect(getKThread(t.id)!.activeRunId).toBe(r1.runId)

    // First send ESTABLISHES: resume=false, a fresh CLI session id, the session's
    // homeDir threaded through. A.1: the spawn is INTERACTIVE (the hybrid live
    // path) — this pinned `interactive` falsy while the W0 adapter was one-shot.
    const ps1 = lastPersistentSession()
    expect(ps1).toMatchObject({ key: t.id, resume: false, homeDir: s.homeDir })
    expect(ps1.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(lastStartRunOpts().interactive).toBe(true)
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toContain('You: hello world')

    // A user-sent message activates the profile with trigger 'user-message'.
    const runs1 = agentRunsDb.listRecentAgentRunsByProfile.all('chief', 10) as Row[]
    expect(runs1[0].trigger).toBe('user-message')

    // The agent answers and exits — captureAnswers folds the reply onto the thread,
    // the terminal hook stamps the SESSION row (cli_session_id + resumable + touch).
    eventBus.emitEvent({ id: uuid(), runId: r1.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'Hello back' })
    eventBus.emitRunUpdate(terminal(r1.runId))

    const kTurns = listKThreadTurns(t.id).filter(x => x.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('Hello back')
    expect(getKThread(t.id)!.activeRunId).toBeNull()

    const row = sessionRow(s.id)!
    expect(row.cli_session_id).toBe(ps1.sessionId)
    expect(row.state).toBe('resumable')
    expect(row.last_activity_at).not.toBeNull()

    // Session-id OWNERSHIP invariant: adapter sends stamp agent_sessions ONLY —
    // k_threads.cli_session_id (K's own askK channel) must stay untouched. Locks
    // the captureAnswers(threadId, runId) call against ever regaining a
    // sessionIdToPersist third argument.
    const threadCli = kThreadsDb.getThreadCliSessionId.get(t.id) as { cli_session_id: string | null }
    expect(threadCli.cli_session_id).toBeNull()

    // Second send RESUMES: resume=true, the SAME session id, and the seed is ONLY
    // the new body — no transcript replay.
    const r2 = await sendToSession(s.id, 'second message')
    expect(r2.mode).toBe('spawned')
    expect(r2.runId).not.toBe(r1.runId)
    const ps2 = lastPersistentSession()
    expect(ps2).toMatchObject({ key: t.id, sessionId: ps1.sessionId, resume: true, homeDir: s.homeDir })
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toBe('second message')
  })

  it('the establishing seed is a NEUTRAL transcript replay — Agent:/You: lines, current body once, no K routing instruction', async () => {
    const { t, s } = setup()
    // Prior history on the conversation (a durable user ask + the agent reply).
    // Backdated created_at via insertTurn: listTurns orders (created_at ASC,
    // id ASC) and ids are random uuids, so same-millisecond appendTurn history
    // scrambles nondeterministically against the send's own turn (the live
    // test's determinism note) — explicit timestamps pin the order.
    const base = Date.now() - 10_000
    kThreadsDb.insertTurn.run({ id: uuid(), threadId: t.id, role: 'user', text: 'earlier question', runId: null, createdAt: base })
    kThreadsDb.insertTurn.run({ id: uuid(), threadId: t.id, role: 'k', text: 'earlier answer', runId: null, createdAt: base + 1_000 })

    await sendToSession(s.id, 'hello again')
    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])

    // History replays under NEUTRAL labels — 'Agent:', never K's 'K:' label.
    expect(seed).toContain('You: earlier question')
    expect(seed).toContain('Agent: earlier answer')
    expect(seed).not.toContain('K: earlier answer')
    // The current message appears exactly once (the just-appended turn is sliced off).
    expect(seed.match(/hello again/g)).toHaveLength(1)
    expect(seed.endsWith('You: hello again')).toBe(true)
    // No K-specific routing instruction rides along (K_SEED_INSTRUCTION markers).
    expect(seed).not.toContain('secretary front door')
    expect(seed).not.toContain('note_add')
  })

  it("a profile-sent message carries the provenance tag in the TURN TEXT only, trigger 'delegation'", async () => {
    const { t, s } = setup()

    await sendToSession(s.id, 'status update', { from: { kind: 'profile', profileId: 'k-secretary' } })

    // Durable turn: tagged. Dispatch seed: the raw body (interim; Lane B owns provenance).
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns[0].text).toBe('[from k-secretary] status update')
    const seed = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(seed).toContain('You: status update')
    expect(seed).not.toContain('[from k-secretary]')

    const runs = agentRunsDb.listRecentAgentRunsByProfile.all('chief', 10) as Row[]
    expect(runs[0].trigger).toBe('delegation')
  })

  it("a NON-done terminal on an establishing send leaves cli_session_id NULL + state 'stale'; the next send re-establishes", async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'first try')
    const sid1 = lastPersistentSession().sessionId
    eventBus.emitRunUpdate(terminal(r1.runId, 'error'))

    const row = sessionRow(s.id)!
    expect(row.cli_session_id).toBeNull()
    expect(row.state).toBe('stale')

    // Next send is a fresh ESTABLISH again — resume=false, a NEW session id.
    await sendToSession(s.id, 'second try')
    const ps = lastPersistentSession()
    expect(ps.resume).toBe(false)
    expect(ps.sessionId).not.toBe(sid1)
  })

  it("a NON-done terminal on a RESUME send keeps the existing cli_session_id + state 'resumable'", async () => {
    const { s } = setup()
    const r1 = await sendToSession(s.id, 'establish me')
    const sid = lastPersistentSession().sessionId
    eventBus.emitRunUpdate(terminal(r1.runId))
    expect(sessionRow(s.id)!.cli_session_id).toBe(sid)

    const r2 = await sendToSession(s.id, 'resume me')
    expect(lastPersistentSession().resume).toBe(true)
    eventBus.emitRunUpdate(terminal(r2.runId, 'killed'))

    const row = sessionRow(s.id)!
    expect(row.cli_session_id).toBe(sid) // resume retries stay possible
    expect(row.state).toBe('resumable')
  })

  it("a COLD send (no live attachment) spawns — mode 'spawned' — and a model override threads through", async () => {
    const { s } = setup()
    const r = await sendToSession(s.id, 'pick a model', { model: 'claude-opus-4-8' })
    expect(r.mode).toBe('spawned')
    expect(lastStartRunOpts().model).toBe('claude-opus-4-8')
  })

  it('a dispatch throw propagates; the durable user turn stays and the session row is untouched', async () => {
    const { t, s } = setup()
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))

    await expect(sendToSession(s.id, 'doomed send')).rejects.toThrow('boom')

    // The thread is the source of truth: the ask survives the failed dispatch.
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].runId).toBeNull()
    const row = sessionRow(s.id)!
    expect(row.cli_session_id).toBeNull()
    expect(row.state).toBe('stale')
  })
})

// ── demoteSession ─────────────────────────────────────────────────────────────

describe('demoteSession — interim pure state transitions', () => {
  function freshSession() {
    const t = getOrCreateConversation('chief')
    return ensureSession('chief', t.id)
  }

  it("'error' demotes to 'stale' from any state", () => {
    const s = freshSession()
    agentSessionsDb.setState.run('resumable', Date.now(), s.id)
    demoteSession(s.id, 'error')
    expect(sessionRow(s.id)!.state).toBe('stale')
  })

  it("'idle'/'boot'/'lru' demote ONLY a 'live' session to 'resumable' (no-op otherwise)", () => {
    const s = freshSession()

    // Not live → no-op (W0 never creates 'live'; Lane A owns real demotion).
    demoteSession(s.id, 'idle')
    expect(sessionRow(s.id)!.state).toBe('stale')
    agentSessionsDb.setState.run('resumable', Date.now(), s.id)
    demoteSession(s.id, 'boot')
    expect(sessionRow(s.id)!.state).toBe('resumable')

    // Live → resumable, for each non-error reason.
    for (const reason of ['idle', 'boot', 'lru'] as const) {
      agentSessionsDb.setState.run('live', Date.now(), s.id)
      demoteSession(s.id, reason)
      expect(sessionRow(s.id)!.state, `reason ${reason}`).toBe('resumable')
    }
  })

  it('an unknown session id is a no-op (idempotent housekeeping)', () => {
    expect(() => demoteSession('no-such-session', 'error')).not.toThrow()
  })
})

// ── liveSessionCount + MAX_LIVE_SESSIONS ──────────────────────────────────────

describe('liveSessionCount + MAX_LIVE_SESSIONS', () => {
  it("counts 'live' rows only", () => {
    expect(liveSessionCount()).toBe(0)
    const t = getOrCreateConversation('chief')
    const s1 = ensureSession('chief', t.id)
    const kt = getOrCreateConversation('k-secretary')
    const s2 = ensureSession('k-secretary', kt.id)

    agentSessionsDb.setState.run('live', Date.now(), s1.id)
    expect(liveSessionCount()).toBe(1)
    agentSessionsDb.setState.run('live', Date.now(), s2.id)
    expect(liveSessionCount()).toBe(2)
    agentSessionsDb.setState.run('resumable', Date.now(), s2.id)
    expect(liveSessionCount()).toBe(1)
  })

  it('MAX_LIVE_SESSIONS defaults to 3; the parser guards NaN/zero/negative', () => {
    expect(MAX_LIVE_SESSIONS).toBe(3) // K_MAX_LIVE_SESSIONS is unset under vitest
    expect(parseMaxLiveSessions('5')).toBe(5)
    expect(parseMaxLiveSessions('0')).toBe(3)
    expect(parseMaxLiveSessions('-2')).toBe(3)
    expect(parseMaxLiveSessions('abc')).toBe(3)
    expect(parseMaxLiveSessions('')).toBe(3)
    expect(parseMaxLiveSessions(undefined)).toBe(3)
  })
})

// ── K-path regression guard — supervisor path selection ──────────────────────

describe('K-path regression guard — homeDir vs kSecretaryConfigPaths', () => {
  const actualSupervisorP = vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  /** Let the aborted runAgent body settle (synthesizeConfigDir throws inside it). */
  const settle = () => new Promise(r => setTimeout(r, 30))

  it('agentSessionPaths mirrors the kSecretaryConfigPaths layout under sessions/<profileId>/<threadId>', () => {
    const dir = path.join(os.tmpdir(), 'k-ca-paths-probe')
    const p = agentSessionPaths('chief', 'kt-chief', dir)
    expect(p.base).toBe(path.join(dir, 'sessions', 'chief', 'kt-chief'))
    // The agent/ + cwd/ layout the supervisor derives from homeDir — keep in lockstep.
    expect(p.runDir).toBe(path.join(p.base, 'agent'))
    expect(p.cwd).toBe(path.join(p.base, 'cwd'))
    // NOT under agent-runs/ (the boot orphan sweep must never reap session state).
    expect(p.base).not.toContain(`${path.sep}agent-runs${path.sep}`)

    // kSecretaryConfigPaths is UNTOUCHED — the K namespace stays k-secretary/<key>.
    const k = kSecretaryConfigPaths('kt-thread', dir)
    expect(k.runDir).toBe(path.join(dir, 'k-secretary', 'kt-thread', 'agent'))
    expect(k.cwd).toBe(path.join(dir, 'k-secretary', 'kt-thread', 'cwd'))

    // Both segments are validated (they are interpolated into fs paths).
    expect(() => agentSessionPaths('../up', 'kt-x', dir)).toThrow(/unsafe/)
    expect(() => agentSessionPaths('chief', '../up', dir)).toThrow(/unsafe/)
  })

  it('REAL startRun without homeDir resolves kSecretaryConfigPaths (K byte-identical)', async () => {
    const { startRun: realStartRun } = await actualSupervisorP
    const key = 'ca-guard-k-thread'
    const run = await realStartRun('k secretary ask', {
      model: 'claude-sonnet-4-6',
      persistentSession: { key, sessionId: uuid(), resume: false },
    })
    realRunIds.push(run.id)

    expect(run.worktree).toBeUndefined()
    expect(run.cwd).toBe(kSecretaryConfigPaths(key).cwd)
    await settle()
  })

  it('REAL startRun WITH homeDir derives the stable cwd from it (agent/ + cwd/ layout)', async () => {
    const { startRun: realStartRun } = await actualSupervisorP
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ca-home-'))
    tmpDirs.push(home)

    const run = await realStartRun('generalized session send', {
      model: 'claude-sonnet-4-6',
      persistentSession: { key: 'ca-guard-session-thread', sessionId: uuid(), resume: false, homeDir: home },
    })
    realRunIds.push(run.id)

    expect(run.worktree).toBeUndefined()
    expect(run.cwd).toBe(path.join(home, 'cwd'))
    // The stable cwd was created — the run would execute inside the session home.
    expect(fs.existsSync(path.join(home, 'cwd'))).toBe(true)
    // And it is NOT the K-secretary namespace for that key.
    expect(run.cwd).not.toBe(kSecretaryConfigPaths('ca-guard-session-thread').cwd)
    await settle()
  })
})
