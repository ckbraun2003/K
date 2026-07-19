/**
 * Agent sessions — the FROZEN session-engine interface + the Lane A HYBRID
 * RUNTIME (Continuous Agents A.1 + A.2, D-122).
 *
 * THE CONTRACT IS FROZEN: Lanes A/B/C build against these exact exported
 * signatures (getOrCreateConversation / ensureSession / sendToSession /
 * demoteSession / liveSessionCount / MAX_LIVE_SESSIONS and the MessageFrom /
 * SendResult shapes). A.1 replaced the W0 interim adapter's INTERNALS with the
 * hybrid live/stdin runtime; A.2 added the demotion lifecycle + per-session
 * send serialization; the signatures did not change.
 *
 * THE HYBRID RUNTIME (A.1): each conversation is a k_threads row (the durable
 * source of truth); each (profile, thread) pair has ONE agent_sessions row whose
 * `home_dir` is a stable per-session directory (agent-config.ts::
 * agentSessionPaths) so the CLI's session files persist across sends and
 * `--resume` finds them. A send is: durable user turn FIRST, then
 *  - LIVE ATTACHMENT (this process spawned an interactive run for the session):
 *    deliver the body into the SAME run via supervisor.sendInput — no new spawn.
 *    A mid-turn send (sendInput false: the run isn't parked at awaiting_input)
 *    queues on the attachment and drains at the next awaiting_input boundary.
 *  - NO ATTACHMENT: spawn an INTERACTIVE run (D-014 persistent stdin — the park
 *    machinery IS the live path) via startAgentRun with persistentSession
 *    {key, sessionId, resume, homeDir}: cli_session_id NULL → establish
 *    (`--session-id`, seeded with a bounded neutral transcript replay); set →
 *    resume (`--resume`, body only). persistentSession also keeps the dispatch
 *    budget-exempt and plan-gate-exempt, exactly like K's own asks.
 *
 * ONE eventBus.onRunUpdate subscription per attachment owns the run lifecycle
 * (replacing W0's trackSupervisedRun finalize):
 *  - INIT (r.cliSessionId observed) → persist cli_session_id NOW, not only on
 *    'done' — a mid-turn death after INIT no longer loses the CLI session.
 *  - awaiting_input → state 'live', context_tokens refresh, drain pending.
 *  - terminal → detach + the FULL A.2 state rules, in precedence order:
 *    (1) undo taint (undoneRuns — A.4's undoSessionRun already forced 'stale' +
 *    cleared the id; the finalize must not resurrect either); (2) forcedState
 *    (demoteSession('error')) → 'stale'; (3) 'done' → 'resumable' (with the
 *    belt-and-suspenders establish stamp below); (4) non-done RESUME without
 *    INIT → resume-rejected: the recorded CLI session is dead — cli_session_id
 *    CLEARED + 'stale' so the next send reseeds (replaces A.1's retry-forever
 *    posture); (5) non-done WITH INIT observed → 'resumable' (a real CLI session
 *    exists — its id was persisted at INIT, so a mid-turn death keeps its
 *    context); (6) non-done establish WITHOUT INIT → 'stale' (id stays NULL —
 *    nothing ever came up). Bodies still pending at a NON-KILLED terminal are
 *    re-dispatched in a fresh spawn (never silently eat a message — the A.1
 *    pending strand is closed); a KILLED run's pending bodies are dropped, but
 *    their durable turns survive for the next manual send's seed replay — an
 *    operator kill is final.
 *
 * THE DEMOTION LIFECYCLE (A.2): a session leaves 'live' four ways —
 *  - 'idle': the supervisor's per-run idle timer (idleMs = SESSION_IDLE_MS,
 *    threaded through the spawn) fires endSession itself; demoteSession('idle')
 *    is the explicit-caller twin (same graceful close).
 *  - 'boot': sweepLiveSessionsOnBoot (index.ts) reconciles rows a dead process
 *    stranded 'live' — attachments are in-process, so after a crash nothing
 *    real backs them.
 *  - 'lru': spawning past maxLive() demotes the least-recently-updated live
 *    session first (demoteLruBeyondCap at the top of spawnSessionRun).
 *  - 'error': forcedState taint — 'stale' immediately AND at the terminal.
 * Graceful demotes flip the row 'resumable' IMMEDIATELY (the UI must not show
 * 'live' while the CLI winds down); the run's later 'done' terminal confirms.
 * NB: on 'done' with NO INIT observed (the mocked-supervisor test path — a real
 * establish always INITs), an establishing attachment still stamps its own
 * sessionId — the D-062 persist-on-success posture kept as a backstop; the INIT
 * stamp is the primary.
 *
 * captureAnswers (k-thread.ts) keeps owning reply-turn capture — it already
 * handles awaiting_input boundaries repeatedly, so each parked turn's assistant
 * text folds onto the durable thread as it lands.
 *
 * CONCURRENT-SEND POSTURE (A.2, real): every delivery runs under a PER-SESSION
 * send lock (withSessionSendLock — a promise chain per session id), so two
 * sends racing before the first attachment registers now SERIALIZE: the first
 * spawns, the second observes the attachment and rides stdin into the same run
 * — the W0/A.1 double-establish exposure is closed. The lock covers the attach
 * decision + dispatch (fast), never a whole turn. Teardown stays
 * IDENTITY-GUARDED (finalize only deletes the map entry it owns) as
 * defense-in-depth: the terminal re-dispatch spawns a successor attachment
 * asynchronously, and the guard makes any finalize/attach interleaving safe by
 * construction rather than by lock-ordering argument.
 *
 * SDK-free like k-thread.ts: no transport import, unit-testable directly against
 * the DB + EventBus (supervisor.sendInput is the one process-touching import,
 * mocked in tests).
 *
 * IMPORT NOTE (A.4): k-thread ↔ agent-sessions is a deliberate, benign ESM cycle
 * — askK rides ensureSession/sendToSession/undoSessionRun here; we ride
 * appendTurn/captureAnswers/listKThreadTurns there. Every cross-reference is
 * call-time and both module bodies stay inert at load (the documented
 * agent-config ↔ run-assets precedent).
 */
import { randomUUID } from 'crypto'
import type { KThread, AgentSession, AgentRunTrigger } from '@k/shared'
import { db, kThreadsDb, agentSessionsDb, runsDb } from './db.js'
import { startAgentRun } from './agent-runs.js'
import { agentSessionPaths, assertSafeSegment } from './agent-config.js'
import { sendInput, endSession } from './supervisor.js'
import { isTerminalRunStatus } from './run-lifecycle.js'
import { eventBus } from './events.js'
import {
  appendTurn,
  captureAnswers,
  ensureDefaultKThread,
  listKThreadTurns,
  rowToKThread,
} from './k-thread.js'

// ── the frozen contract types ─────────────────────────────────────────────────

/** Who a message came from: the operator, or another agent profile. */
export type MessageFrom = { kind: 'user' } | { kind: 'profile'; profileId: string }

/** How a send was delivered: 'spawned' = a new run was dispatched (cold path);
 *  'stdin' = delivered into a live attached run (the hybrid live path). */
export type SendResult = { mode: 'stdin'; runId: string } | { mode: 'spawned'; runId: string }

/** Thrown when sendToSession/demoteSession is handed an unknown session id —
 *  route layers map this to 404 (the KThreadNotFoundError precedent). */
export class AgentSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`agent session not found: ${id}`)
  }
}

// ── config ────────────────────────────────────────────────────────────────────

/** Parse K_MAX_LIVE_SESSIONS: a positive integer, else the default 3. Pure +
 *  exported so the env guard is unit-lockable without re-importing the module. */
export function parseMaxLiveSessions(raw: string | undefined): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 3
}

/** How many sessions may hold a live process at once (demoteLruBeyondCap
 *  enforces it at spawn time; frozen here so all lanes read ONE knob). */
export const MAX_LIVE_SESSIONS: number = parseMaxLiveSessions(process.env.K_MAX_LIVE_SESSIONS)

/** Parse K_SESSION_IDLE_MS: a positive integer of milliseconds, else the default
 *  10 minutes. Pure + exported (the parseMaxLiveSessions pattern) so the env
 *  guard is unit-lockable without re-importing the module. */
export function parseSessionIdleMs(raw: string | undefined): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000
}

/** How long a live session may sit parked at awaiting_input before the
 *  supervisor gracefully ends it (threaded to the spawn as the per-run `idleMs`
 *  override, so the session knob is independent of INTERACTIVE_IDLE_MS). */
export const SESSION_IDLE_MS: number = parseSessionIdleMs(process.env.K_SESSION_IDLE_MS)

/** Test-only override for the live cap (K_MAX_LIVE_SESSIONS is baked into the
 *  frozen MAX_LIVE_SESSIONS const at import time, so tests need a runtime seam).
 *  null → the frozen export. Set via __sessionTestHooks.setMaxLive. */
let maxLiveOverride: number | null = null
const maxLive = (): number => maxLiveOverride ?? MAX_LIVE_SESSIONS

/** How many recent turns fold into an establishing seed (mirrors k-thread.ts's
 *  SEED_TURN_WINDOW so a reseed stays equally bounded). */
const SESSION_SEED_TURN_WINDOW = 12

/** The K-secretary front door keeps its own multi-thread model: K callers pass
 *  threads explicitly (askK/resolveAskThread), so ITS "single conversation" is
 *  the default thread, not a kt-<profile> row. */
const K_SECRETARY_PROFILE_ID = 'k-secretary'

// ── row → type mapper ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function rowToAgentSession(r: Row): AgentSession {
  return {
    id: String(r.id),
    profileId: String(r.profile_id),
    threadId: String(r.thread_id),
    cliSessionId: r.cli_session_id == null ? null : String(r.cli_session_id),
    homeDir: String(r.home_dir),
    state: r.state as AgentSession['state'],
    contextTokens: r.context_tokens == null ? null : Number(r.context_tokens),
    lastActivityAt: r.last_activity_at == null ? null : Number(r.last_activity_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

// ── conversations ─────────────────────────────────────────────────────────────

// kThreadsDb.insertThread cannot bind profile_id (it predates v16 and lets the
// column take its DEFAULT 'k-secretary'), so creating a NON-K conversation needs
// a local prepared statement stamping the owner. Prepared here — not added to
// db.ts — per the house precedent for keeping a frozen db bundle untouched
// (k-thread.ts::getDelegatingKRunForPipeline / clearThreadCliSessionByThreadId).
// OR IGNORE: a cross-process racing double-call (main server + a per-run stdio MCP
// child both resolving the same profile's conversation) must converge on ONE row,
// not crash the loser with a PK throw — the owner-filtered re-select below returns
// whichever insert won. A foreign row already holding the deterministic id (a
// k-secretary `kt-<uuid8>` thread whose suffix collides with a profile id —
// far-fetched but representable) is NOT silently adopted: the re-select filters by
// owner and the miss throws instead.
const insertProfileConversation = db.prepare(
  `INSERT OR IGNORE INTO k_threads (id, title, status, profile_id, created_at, updated_at)
   VALUES (@id, NULL, 'active', @profileId, @createdAt, @updatedAt)`,
)

/**
 * The profile's SINGLE conversation (single-conversation agents; K callers pass
 * threads explicitly, so 'k-secretary' resolves to the default K thread). For any
 * other profile: the most-recent existing thread owned by it, else a fresh one
 * with a DETERMINISTIC id `kt-<profileId>` — deterministic so a racing double-call
 * converges on one row, and segment-safe by construction (the profile id is
 * validated first; the thread id later keys agentSessionPaths). Title stays null
 * (the title-on-first-send convention belongs to the UI layer, not here).
 */
export function getOrCreateConversation(profileId: string): KThread {
  if (profileId === K_SECRETARY_PROFILE_ID) return ensureDefaultKThread()
  assertSafeSegment(profileId, 'conversation profile id')
  const rows = kThreadsDb.listByProfile.all(profileId) as Row[]
  if (rows.length > 0) return rowToKThread(rows[0])
  const id = `kt-${profileId}`
  const now = Date.now()
  insertProfileConversation.run({ id, profileId, createdAt: now, updatedAt: now })
  // Owner-filtered re-select (NOT getThread(id)): under the OR-IGNORE race this
  // returns the winner's row; if the id was held by ANOTHER profile's thread the
  // insert was ignored and this misses — throw rather than adopt a foreign thread.
  const created = kThreadsDb.listByProfile.all(profileId) as Row[]
  if (created.length === 0) {
    throw new Error(
      `getOrCreateConversation: thread id ${id} already exists but is not owned by ${profileId}`,
    )
  }
  return rowToKThread(created[0])
}

// ── sessions ──────────────────────────────────────────────────────────────────

/**
 * Get-or-create the (profile, thread) session row. Session identity is the PAIR
 * (UNIQUE(profile_id, thread_id)): a new row is born 'stale' (the DDL default —
 * nothing to resume yet) with `home_dir` = the stable agentSessionPaths base; a
 * later call REFRESHES the row but must not clobber what the terminal hooks own
 * — the upsert SQL overwrites every mutable column with the excluded values, so
 * the existing state / cli_session_id / activity are read first and passed back
 * through. home_dir alone is always recomputed: it derives deterministically from
 * the pair, so this is a no-op unless K_DATA_DIR moved between boots — in which
 * case refreshing to the live location is exactly right.
 */
export function ensureSession(profileId: string, threadId: string): AgentSession {
  const existing = agentSessionsDb.getByProfileThread.get(profileId, threadId) as Row | undefined
  const now = Date.now()
  const row = agentSessionsDb.upsert({
    id: existing ? String(existing.id) : randomUUID(),
    profileId,
    threadId,
    cliSessionId: existing?.cli_session_id == null ? null : String(existing.cli_session_id),
    homeDir: agentSessionPaths(profileId, threadId).base,
    state: existing ? String(existing.state) : 'stale',
    contextTokens: existing?.context_tokens == null ? null : Number(existing.context_tokens),
    lastActivityAt: existing?.last_activity_at == null ? null : Number(existing.last_activity_at),
    createdAt: existing ? Number(existing.created_at) : now,
    updatedAt: now,
  })
  return rowToAgentSession(row)
}

// ── live attachments (the hybrid runtime's module state) ─────────────────────

/** A queued mid-turn body + its durable turn id, kept together so a terminal
 *  re-dispatch can RE-POINT the turn at the successor run that actually answers
 *  it (and exclude it from the reseed window by id, not position). */
type PendingBody = { body: string; turnId: string }

/** A live run attached to a session: the in-process record binding the session
 *  to ITS interactive run, torn down at the run's terminal. */
type Attachment = {
  runId: string
  /** Durably-recorded bodies awaiting the next turn boundary (mid-turn sends). */
  pending: PendingBody[]
  /** The run emitted its stream-json INIT line (cli_session_id observed). */
  initSeen: boolean
  /** This attachment was spawned with `--resume`. */
  resume: boolean
  /** The CLI session id the spawn established/resumed. */
  cliSessionId: string
  /** demoteSession('error') override: the terminal finalize lands here instead
   *  of the status-derived state (the taint outlives the graceful endSession). */
  forcedState?: 'stale'
  unsub: () => void
}

/** sessionId → live run attachment. In-process only: a session another process
 *  (or a previous boot) spawned is simply not attached here — sends to it take
 *  the cold spawn path (sweepLiveSessionsOnBoot reconciles the stranded 'live'
 *  rows a dead process left behind). */
const attachments = new Map<string, Attachment>()
/** runId → sessionId reverse lookup (undo taint without a DB roundtrip — A.4). */
const runToSession = new Map<string, string>()
/** Undo taint: run ids undoSessionRun (A.4) scrubbed. The terminal finalize
 *  consumes the marker and does NOTHING — undo already forced 'stale' + cleared
 *  cli_session_id, and a later terminal must not resurrect 'resumable'. Bounded
 *  by undo frequency (a rare, explicit operator action); an id whose run already
 *  finalized before the undo is never consumed — accepted, same as k-thread's
 *  undoneRuns idiom. */
const undoneRuns = new Set<string>()

// Local statements (the frozen-db-bundle precedent — see insertProfileConversation).
const setSessionContextTokens = db.prepare(
  `UPDATE agent_sessions SET context_tokens = ?, updated_at = ? WHERE id = ?`,
)
const latestContextTokens = db.prepare(
  `SELECT context_tokens FROM events WHERE run_id = ? AND context_tokens IS NOT NULL
   ORDER BY seq DESC LIMIT 1`,
)

/** Refresh the session row's context_tokens from the run's latest observed
 *  context-size event (Wave D6 column) — the demote-at-threshold signal. */
function updateSessionContextTokens(sessionId: string, runId: string): void {
  const row = latestContextTokens.get(runId) as { context_tokens?: number | null } | undefined
  if (row?.context_tokens != null) {
    setSessionContextTokens.run(Number(row.context_tokens), Date.now(), sessionId)
  }
}

/**
 * Render the establishing seed for a fresh/reset session: the last
 * {@link SESSION_SEED_TURN_WINDOW} durable turns as NEUTRAL `You:` / `Agent:`
 * lines, then one `You: <body>` line per current body. The caller persists the
 * current user turn(s) BEFORE this runs; those turns are excluded from the
 * history window BY ID — not by trailing position, because on the terminal
 * re-dispatch path a captured assistant fragment can land AFTER the queued
 * bodies, and positional math would drop it and double the body instead
 * (spec-review S2). The k-thread.ts::renderSeed shape, minus
 * K_SEED_INSTRUCTION: that instruction is K-routing-specific (secretary
 * store/route steering) and must not leak into an arbitrary profile's seed.
 * Takes a body ARRAY because A.2's pending re-dispatch reseeds a batch of
 * queued bodies in one spawn.
 */
function renderSessionSeed(threadId: string, bodies: string[], excludeTurnIds: string[]): string {
  const exclude = new Set(excludeTurnIds)
  const turns = listKThreadTurns(threadId).filter(t => !exclude.has(t.id))
  const recent = turns.slice(-SESSION_SEED_TURN_WINDOW)
  const lines = recent.map(t => `${t.role === 'user' ? 'You' : 'Agent'}: ${t.text}`)
  for (const b of bodies) lines.push(`You: ${b}`)
  return lines.join('\n')
}

// ── per-session send serialization (A.2) ─────────────────────────────────────

/** sessionId → the tail of its send chain. Entries are never removed: the map
 *  is bounded by the number of sessions this process ever touched (small), and
 *  removal would race a concurrent enqueue reading a just-deleted tail. */
const sendChains = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` behind every prior send for the session. The chain advances on
 * settle-either-way (`then(fn, fn)`): one failed dispatch must not wedge the
 * session forever. The RETURNED promise is the un-swallowed `fn` result so the
 * caller still observes its own rejection; the STORED tail swallows both arms —
 * it exists only for ordering, and an unhandled-rejection warning on the shared
 * tail would fire once per queued successor.
 */
function withSessionSendLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendChains.get(sessionId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  sendChains.set(sessionId, next.then(() => undefined, () => undefined))
  return next
}

/**
 * Send one message into a session — the hybrid live path (see the module
 * header for the full delivery contract). Validates the id EAGERLY (an unknown
 * id must throw now, not after unrelated queued sends settle), then delivers
 * under the per-session send lock; deliverToSession re-reads the row so the
 * locked delivery always acts on a fresh view.
 */
export async function sendToSession(
  sessionId: string,
  body: string,
  opts?: { from?: MessageFrom; model?: string },
): Promise<SendResult> {
  if (!agentSessionsDb.get.get(sessionId)) throw new AgentSessionNotFoundError(sessionId)
  return withSessionSendLock(sessionId, () => deliverToSession(sessionId, body, opts ?? {}))
}

/**
 * The delivery core: durable user turn first (the thread is the source of
 * truth; it survives a dispatch throw), then stdin into the live attachment or
 * a cold interactive spawn. A profile-sent message gets a `[from <profileId>] `
 * provenance prefix in the TURN TEXT ONLY — Lane B owns real provenance
 * (agent_messages rows) — the dispatch/stdin payload carries the raw body.
 * Re-reads the session row itself so A.2's lock can serialize on a fresh view.
 */
async function deliverToSession(
  sessionId: string,
  body: string,
  opts: { from?: MessageFrom; model?: string },
): Promise<SendResult> {
  const row = agentSessionsDb.get.get(sessionId) as Row | undefined
  if (!row) throw new AgentSessionNotFoundError(sessionId)
  const session = rowToAgentSession(row)

  const from: MessageFrom = opts.from ?? { kind: 'user' }
  const turnText = from.kind === 'profile' ? `[from ${from.profileId}] ${body}` : body
  const turn = appendTurn(session.threadId, 'user', turnText, null)

  const att = attachments.get(sessionId)
  if (att) {
    // Live attachment: the turn belongs to the attached run either way — as a
    // parked-turn delivery (sendInput true) or as a queued body drained at the
    // next awaiting_input boundary (sendInput false: the run is mid-turn).
    kThreadsDb.patchTurnRunId.run(att.runId, turn.id)
    if (!sendInput(att.runId, body)) att.pending.push({ body, turnId: turn.id })
    const now = Date.now()
    // Bump thread recency too (spawn does this via updateThreadActiveRun): the
    // thread list orders on k_threads.updated_at and the no-threadId ask default
    // resolves the most-recent thread — a warm stdin send must count as activity
    // or an actively-warm thread gets out-ordered by any colder write.
    kThreadsDb.updateThreadActiveRun.run(att.runId, now, session.threadId)
    agentSessionsDb.touch(sessionId, now)
    return { mode: 'stdin', runId: att.runId }
  }

  const runId = await spawnSessionRun(session, [body], { from, model: opts.model, turnIds: [turn.id] })
  return { mode: 'spawned', runId }
}

/**
 * Spawn the session's INTERACTIVE run and wire the attachment. cli_session_id
 * NULL → establish (fresh `--session-id`, neutral transcript seed); set →
 * resume (`--resume`, bodies only). Trigger: a user send is 'user-message'; a
 * profile send is 'delegation' — the most honest member of today's
 * AgentRunTrigger union for one profile handing a message to another (there is
 * no 'message' trigger until Lane B). A dispatch throw propagates unchanged
 * (startAgentRun already rolled its tracking row back to 'failed'); the durable
 * user turn stays and the session row is untouched — the next send simply tries
 * the same establish/resume again, with no attachment left behind.
 */
async function spawnSessionRun(
  session: AgentSession,
  bodies: string[],
  opts: { from: MessageFrom; model?: string; turnIds: string[] },
): Promise<string> {
  // LRU cap FIRST: free a live slot synchronously before this spawn can park
  // into one (the demote is an endSession + immediate state flip, so the cap
  // holds even though the demoted run's terminal lands later).
  demoteLruBeyondCap()
  const resume = session.cliSessionId != null
  const cliSessionId = session.cliSessionId ?? randomUUID()
  const seed = resume ? bodies.join('\n\n') : renderSessionSeed(session.threadId, bodies, opts.turnIds)
  const trigger: AgentRunTrigger = opts.from.kind === 'profile' ? 'delegation' : 'user-message'
  const { runId } = await startAgentRun(session.profileId, {
    trigger,
    thread: seed,
    model: opts.model,
    interactive: true, // the D-014 park machinery IS the live path
    // A.2: the session idle knob rides the per-run override — a parked session
    // run demotes on SESSION_IDLE_MS, not the HITL INTERACTIVE_IDLE_MS.
    idleMs: SESSION_IDLE_MS,
    // A.3 (D-127): stamp the OWNING agent_sessions row onto the run
    // (startAgentRun → startRun → runs.session_id); the run's kind resolves to
    // 'chat-turn' from persistentSession along the same path.
    sessionId: session.id,
    persistentSession: { key: session.threadId, sessionId: cliSessionId, resume, homeDir: session.homeDir },
  })
  kThreadsDb.updateThreadActiveRun.run(runId, Date.now(), session.threadId)
  for (const id of opts.turnIds) kThreadsDb.patchTurnRunId.run(runId, id)
  captureAnswers(session.threadId, runId)
  attachSessionRun(session.id, runId, { resume, cliSessionId })
  agentSessionsDb.touch(session.id, Date.now())
  return runId
}

/**
 * Register the session ↔ run attachment and its ONE run-update subscription
 * (INIT persist / park handling / terminal finalize — module header). Finalize
 * is once-latched with unsub-before-write and a subscribe-race backstop — the
 * captureAnswers / trackSupervisedRun discipline, owned here because the
 * attachment must also detach itself (Maps + subscription) at terminal.
 */
function attachSessionRun(
  sessionId: string,
  runId: string,
  meta: { resume: boolean; cliSessionId: string },
): void {
  const att: Attachment = {
    runId,
    pending: [],
    initSeen: false,
    resume: meta.resume,
    cliSessionId: meta.cliSessionId,
    unsub: () => {},
  }
  attachments.set(sessionId, att)
  runToSession.set(runId, sessionId)
  let done = false
  const finalize = (status: string): void => {
    if (done) return
    done = true
    att.unsub()
    // Identity-guarded teardown: under the pre-A.2 double-establish race a
    // SECOND attachment may have replaced this one in the map — an unconditional
    // delete would tear down the LIVE successor's entry and strand its run.
    // Only remove what is still ours (runToSession is keyed by our unique runId,
    // so that delete is unconditionally safe).
    if (attachments.get(sessionId) === att) attachments.delete(sessionId)
    runToSession.delete(runId)
    finalizeSessionTerminal(sessionId, att, status)
  }
  att.unsub = eventBus.onRunUpdate(r => {
    if (r.id !== runId) return
    if (!att.initSeen && r.cliSessionId) {
      // INIT — persist NOW, not only on done: a mid-turn death after this point
      // keeps the CLI session resumable (the old persist-only-on-done loss).
      att.initSeen = true
      agentSessionsDb.setCliSessionId.run(r.cliSessionId, Date.now(), sessionId)
    }
    if (r.status === 'awaiting_input') {
      const now = Date.now()
      agentSessionsDb.setState.run('live', now, sessionId)
      updateSessionContextTokens(sessionId, runId)
      agentSessionsDb.touch(sessionId, now)
      drainPending(att)
      return
    }
    if (isTerminalRunStatus(r.status)) finalize(r.status)
  })
  // Backstop the await/subscribe race: a fast-failing run can reach terminal
  // before the subscription above existed — finalize from the DB status (once).
  const current = (runsDb.getRun.get(runId) as { status?: string } | undefined)?.status
  if (isTerminalRunStatus(current)) finalize(current)
}

/** Drain queued mid-turn bodies into the (now parked) run as ONE combined turn.
 *  A refused drain (the park was consumed concurrently) re-queues for the next
 *  boundary — a body is never dropped while the attachment lives, and bodies
 *  still queued at the run's terminal are RE-DISPATCHED in a fresh spawn by
 *  finalizeSessionTerminal (operator kills excepted) — the A.1 pending strand
 *  is closed. */
function drainPending(att: Attachment): void {
  if (att.pending.length === 0) return
  const entries = att.pending.splice(0)
  if (!sendInput(att.runId, entries.map(e => e.body).join('\n\n'))) att.pending.push(...entries)
}

/**
 * Terminal state rules — the FULL A.2 set, in precedence order (module header):
 *  1. undo taint (undoneRuns, populated by A.4's undoSessionRun): consume the
 *     marker and write NOTHING — undo already forced 'stale' + cleared the id,
 *     and the run's turns are gone, so any state write here would resurrect a
 *     conversation the operator scrubbed.
 *  2. forcedState (demoteSession('error')): land there, skipping the establish
 *     stamp with it — an errored session must not record a session id 'done'
 *     would otherwise stamp.
 *  3. 'done' → 'resumable'; an ESTABLISH that never INITed additionally stamps
 *     its own sessionId (belt-and-suspenders D-062 — the INIT stamp is primary,
 *     and a resume never overwrites the id it resumed).
 *  4. non-done RESUME without INIT → resume-rejected: the recorded CLI session
 *     is dead (the CLI never came up on `--resume`), so retrying it forever —
 *     A.1's posture — could never recover. Clear cli_session_id + 'stale': the
 *     next send re-establishes from the durable transcript (W0 checklist item).
 *  5. non-done WITH INIT observed → 'resumable': a REAL CLI session exists —
 *     its id was persisted at the INIT event, so a mid-turn death (error/kill)
 *     keeps the context and the next send resumes it.
 *  6. non-done ESTABLISH without INIT → 'stale' (cli_session_id still NULL):
 *     no CLI session ever came up — the next send reseeds cleanly.
 * context_tokens refreshes on every non-tainted terminal (last observed size).
 *
 * PENDING RE-DISPATCH (closes the A.1 documented strand): bodies still queued
 * at the terminal are re-delivered in ONE deliver-shaped lock job — their
 * durable turns already exist (deliverToSession appends before queueing) and
 * their ids ride along, so whichever run ends up answering (a fresh spawn, or a
 * successor attachment a racing send cold-spawned first) gets the turns
 * RE-POINTED to it and the establish seed excludes them by id. Exceptions:
 * status 'killed' (an operator kill is final — the turns survive for the next
 * MANUAL send's seed) and the taint/forced arms above (undo scrubbed the turns;
 * 'error' demotion is a deliberate teardown). A failure is LOGGED, never
 * swallowed silently — the message is durably on the thread either way.
 */
function finalizeSessionTerminal(sessionId: string, att: Attachment, status: string): void {
  const now = Date.now()
  if (undoneRuns.delete(att.runId)) return
  if (att.forcedState) {
    agentSessionsDb.setState.run(att.forcedState, now, sessionId)
    return
  }
  updateSessionContextTokens(sessionId, att.runId)
  if (status === 'done') {
    if (!att.initSeen && !att.resume) {
      agentSessionsDb.setCliSessionId.run(att.cliSessionId, now, sessionId)
    }
    agentSessionsDb.setState.run('resumable', now, sessionId)
  } else if (att.resume && !att.initSeen) {
    // Resume-rejected (rule 4): reseed on the next send.
    agentSessionsDb.setCliSessionId.run(null, now, sessionId)
    agentSessionsDb.setState.run('stale', now, sessionId)
  } else if (att.initSeen) {
    agentSessionsDb.setState.run('resumable', now, sessionId)
  } else {
    agentSessionsDb.setState.run('stale', now, sessionId)
  }
  agentSessionsDb.touch(sessionId, now)
  if (att.pending.length > 0 && status !== 'killed') {
    const entries = att.pending.splice(0)
    // Deliver-shaped re-dispatch (quality m2 / spec S1): the row AND the
    // attachment map are re-read INSIDE the locked job — so it sees the decided
    // establish/resume posture (e.g. a cleared id after resume-rejected), and a
    // user send that won the lock first and cold-spawned a successor is RIDDEN
    // via stdin/pending instead of double-spawned over. Recovered turns are
    // re-pointed at whichever run actually answers them (quality m1).
    void withSessionSendLock(sessionId, async () => {
      const row = agentSessionsDb.get.get(sessionId) as Row | undefined
      if (!row) return
      const successor = attachments.get(sessionId)
      if (successor) {
        for (const e of entries) kThreadsDb.patchTurnRunId.run(successor.runId, e.turnId)
        if (!sendInput(successor.runId, entries.map(e => e.body).join('\n\n'))) {
          successor.pending.push(...entries)
        }
        return
      }
      await spawnSessionRun(rowToAgentSession(row), entries.map(e => e.body), {
        from: { kind: 'user' },
        turnIds: entries.map(e => e.turnId),
      })
    }).catch(e => console.warn('[agent-sessions] pending re-dispatch failed:', e))
  }
}

// ── demotion + counters ───────────────────────────────────────────────────────

/**
 * Demote a session — the REAL A.2 lifecycle work (frozen signature).
 *  - 'error': taint the live attachment (forcedState — the terminal finalize
 *    must confirm 'stale', or a clean 'done' would resurrect 'resumable'),
 *    gracefully end its run, clear cli_session_id (stale = reseed; resume keys
 *    solely off the id), and mark 'stale' NOW — from any state, attached or
 *    not (the W0 posture: 'error' is always an honest downgrade).
 *  - 'idle'/'boot'/'lru': graceful demote — endSession the attached run (stdin
 *    close → the run finishes its turn and lands 'done'; the finalize confirms)
 *    and flip 'resumable' IMMEDIATELY, so the row never shows 'live' while the
 *    CLI winds down and an LRU caller can count the freed slot synchronously.
 *    A session neither 'live' nor attached is a no-op (W0 parity — demotion is
 *    idempotent housekeeping called from sweeps/timers).
 * An unknown id is a silent no-op. Writes go through the agentSessionsDb
 * helpers so updated_at always advances.
 */
export function demoteSession(sessionId: string, reason: 'idle' | 'boot' | 'lru' | 'error'): void {
  const row = agentSessionsDb.get.get(sessionId) as Row | undefined
  if (!row) return
  const now = Date.now()
  const att = attachments.get(sessionId)
  if (reason === 'error') {
    if (att) {
      att.forcedState = 'stale'
      endSession(att.runId)
    }
    // 'stale' must MEAN reseed: spawnSessionRun keys resume solely off
    // cli_session_id, so a retained id would silently resume the errored CLI
    // session on the next send (quality m3, deviation-flagged).
    agentSessionsDb.setCliSessionId.run(null, now, sessionId)
    agentSessionsDb.setState.run('stale', now, sessionId)
    return
  }
  if (String(row.state) !== 'live' && !att) return
  if (att) endSession(att.runId) // graceful stdin close → 'done' → finalize confirms
  agentSessionsDb.setState.run('resumable', now, sessionId)
}

/**
 * Enforce the live cap BEFORE a spawn takes a slot: demote live sessions from
 * the least-recently-updated end until (live + the incoming one) fits under
 * maxLive(). listByState('live') is updated_at DESC — the tail is the LRU end.
 * The demote flips state synchronously, so one pass suffices; over-cap states
 * (a lowered env knob across boots) shed the whole excess, not just one row.
 */
function demoteLruBeyondCap(): void {
  const live = agentSessionsDb.listByState.all('live') as Row[]
  const excess = live.length - (maxLive() - 1)
  if (excess <= 0) return
  for (const row of live.slice(live.length - excess)) demoteSession(String(row.id), 'lru')
}

/**
 * Boot reconcile: rows stranded 'live' by a dead process (attachments are
 * in-process, so after a crash/restart nothing real backs a 'live' row — the
 * CLI children died with the supervisor). Flip them 'resumable' in one UPDATE;
 * their cli_session_id survives, so the next send resumes normally. Returns the
 * count for the boot log. Takes the db handle for test injection only (the
 * default is the process singleton).
 */
export function sweepLiveSessionsOnBoot(d: import('better-sqlite3').Database = db): number {
  return d
    .prepare(`UPDATE agent_sessions SET state = 'resumable', updated_at = ? WHERE state = 'live'`)
    .run(Date.now()).changes
}

/**
 * Scrub a session run the operator UNDID (k-thread.ts::undoK — A.4). Taint FIRST:
 * the terminal finalize consumes the marker and writes NOTHING, so a late
 * terminal from the killed run can never resurrect 'resumable'. Then resolve the
 * owning session — the in-process reverse map for a live attachment, else the
 * A.3 runs.session_id stamp (a fast run can finish and detach INSIDE the undo
 * window) — clear cli_session_id (the CLI context carries the undone message)
 * and force 'stale', so the next send re-establishes from the already-cleaned
 * durable turns. No session resolves (not a session run) → taint-only no-op.
 *
 * A still-installed attachment is torn down HERE, not left for the kill's
 * terminal finalize: the kill lands ASYNC (SIGTERM → 3s SIGKILL escalation), so
 * leaving the attachment installed opens a multi-second window where (a) a
 * follow-up send rides stdin into the DYING run and is silently swallowed —
 * undo-then-retype is the canonical undo flow — and (b) a late awaiting_input
 * from the dying CLI re-marks the scrubbed row 'live' with no finalize left to
 * correct it (the taint arm writes nothing). Teardown mirrors finalize exactly
 * (unsub + identity-guarded map deletes), so the next send cold-spawns a fresh
 * establish; the taint stays as the belt for a finalize already in flight. Any
 * pending bodies die with the attachment — their durable turns are exactly what
 * undoK is deleting.
 */
export function undoSessionRun(runId: string): void {
  undoneRuns.add(runId) // finalize taint FIRST — before the kill can produce a terminal
  const sessionId =
    runToSession.get(runId) ??
    ((runsDb.getRun.get(runId) as { session_id?: string | null } | undefined)?.session_id ?? undefined)
  if (!sessionId) return
  const att = attachments.get(sessionId)
  if (att && att.runId === runId) {
    att.unsub()
    attachments.delete(sessionId)
  }
  runToSession.delete(runId)
  const now = Date.now()
  agentSessionsDb.setCliSessionId.run(null, now, sessionId)
  agentSessionsDb.setState.run('stale', now, sessionId)
}

/** Test-only seams (the supervisor __testHooks precedent — keep usage confined
 *  to core/test/*): the live-cap override (MAX_LIVE_SESSIONS is a frozen const
 *  baked at import time) and attachment introspection without exporting the map. */
export const __sessionTestHooks = {
  /** Override maxLive() (null restores the frozen MAX_LIVE_SESSIONS). */
  setMaxLive(n: number | null) { maxLiveOverride = n },
  /** The run id currently attached to a session, if any. */
  attachedRunId(sessionId: string): string | undefined { return attachments.get(sessionId)?.runId },
}

/** How many sessions currently hold state 'live'. A full-row list is fine at
 *  this scale (bounded by MAX_LIVE_SESSIONS once A.2 enforces the cap). */
export function liveSessionCount(): number {
  return (agentSessionsDb.listByState.all('live') as Row[]).length
}
