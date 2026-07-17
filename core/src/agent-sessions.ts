/**
 * Agent sessions — the FROZEN session-engine interface + the Lane A HYBRID
 * RUNTIME (Continuous Agents A.1, D-122).
 *
 * THE CONTRACT IS FROZEN: Lanes A/B/C build against these exact exported
 * signatures (getOrCreateConversation / ensureSession / sendToSession /
 * demoteSession / liveSessionCount / MAX_LIVE_SESSIONS and the MessageFrom /
 * SendResult shapes). A.1 replaced the W0 interim adapter's INTERNALS with the
 * hybrid live/stdin runtime; the signatures did not change.
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
 *  - terminal → detach + state rules: 'done' → 'resumable' (with the
 *    belt-and-suspenders establish stamp below); non-done WITH INIT observed →
 *    'resumable' (a real CLI session exists — its id was persisted at INIT, so a
 *    mid-turn death keeps its context); non-done establish WITHOUT INIT →
 *    'stale' (id stays NULL — nothing ever came up); non-done resume WITHOUT
 *    INIT → 'resumable' (A.1 retry posture). A.2 upgrades these to the full rule
 *    set (resume-rejected → 'stale' + id clear, undo taint, forcedState).
 * NB: on 'done' with NO INIT observed (the mocked-supervisor test path — a real
 * establish always INITs), an establishing attachment still stamps its own
 * sessionId — the D-062 persist-on-success posture kept as a backstop; the INIT
 * stamp is the primary.
 *
 * captureAnswers (k-thread.ts) keeps owning reply-turn capture — it already
 * handles awaiting_input boundaries repeatedly, so each parked turn's assistant
 * text folds onto the durable thread as it lands.
 *
 * CONCURRENT-SEND POSTURE (A.1, documented): two sends racing BEFORE the first
 * attachment registers can still double-establish (the W0 exposure, inherited
 * from askK) — both spawn, the second attachment replaces the first in the map,
 * and the two runs briefly coexist until their terminals. Teardown is
 * IDENTITY-GUARDED (finalize only deletes the map entry it owns), so the
 * loser's terminal can never evict the surviving attachment. A.2's per-session
 * send lock closes the entry race itself. Once an attachment exists, concurrent
 * sends converge on the one live run by construction.
 *
 * SDK-free like k-thread.ts: no transport import, unit-testable directly against
 * the DB + EventBus (supervisor.sendInput is the one process-touching import,
 * mocked in tests).
 */
import { randomUUID } from 'crypto'
import type { KThread, AgentSession, AgentRunTrigger } from '@k/shared'
import { db, kThreadsDb, agentSessionsDb, runsDb } from './db.js'
import { startAgentRun } from './agent-runs.js'
import { agentSessionPaths, assertSafeSegment } from './agent-config.js'
import { sendInput } from './supervisor.js'
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

/** How many sessions may hold a live process at once (A.2's LRU bound enforces
 *  it; frozen here so all lanes read ONE knob). */
export const MAX_LIVE_SESSIONS: number = parseMaxLiveSessions(process.env.K_MAX_LIVE_SESSIONS)

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

/** A live run attached to a session: the in-process record binding the session
 *  to ITS interactive run, torn down at the run's terminal. */
type Attachment = {
  runId: string
  /** Durably-recorded bodies awaiting the next turn boundary (mid-turn sends). */
  pending: string[]
  /** The run emitted its stream-json INIT line (cli_session_id observed). */
  initSeen: boolean
  /** This attachment was spawned with `--resume`. */
  resume: boolean
  /** The CLI session id the spawn established/resumed. */
  cliSessionId: string
  /** demoteSession('error') override for the terminal finalize (A.2). */
  forcedState?: 'stale'
  unsub: () => void
}

/** sessionId → live run attachment. In-process only: a session another process
 *  (or a previous boot) spawned is simply not attached here — sends to it take
 *  the cold spawn path (A.2's boot sweep reconciles the stranded 'live' rows). */
const attachments = new Map<string, Attachment>()
/** runId → sessionId reverse lookup (undo taint without a DB roundtrip — A.4). */
const runToSession = new Map<string, string>()

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
 * current user turn(s) BEFORE this runs, so the trailing `bodies.length` turns
 * are sliced OFF the history window and appear exactly once as the trailing
 * lines — the k-thread.ts::renderSeed shape, minus K_SEED_INSTRUCTION: that
 * instruction is K-routing-specific (secretary store/route steering) and must
 * not leak into an arbitrary profile's seed. Takes a body ARRAY because A.2's
 * pending re-dispatch reseeds a batch of queued bodies in one spawn.
 */
function renderSessionSeed(threadId: string, bodies: string[]): string {
  const turns = listKThreadTurns(threadId)
  const recent = turns.slice(-(SESSION_SEED_TURN_WINDOW + bodies.length), turns.length - bodies.length)
  const lines = recent.map(t => `${t.role === 'user' ? 'You' : 'Agent'}: ${t.text}`)
  for (const b of bodies) lines.push(`You: ${b}`)
  return lines.join('\n')
}

/**
 * Send one message into a session — the hybrid live path (see the module
 * header for the full delivery contract). Validates the id, then delivers.
 * A.2 wraps the delivery in the per-session send lock; in A.1 the call is
 * direct (the W0 double-establish exposure stands until then, documented).
 */
export async function sendToSession(
  sessionId: string,
  body: string,
  opts?: { from?: MessageFrom; model?: string },
): Promise<SendResult> {
  if (!agentSessionsDb.get.get(sessionId)) throw new AgentSessionNotFoundError(sessionId)
  return deliverToSession(sessionId, body, opts ?? {})
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
    if (!sendInput(att.runId, body)) att.pending.push(body)
    agentSessionsDb.touch(sessionId, Date.now())
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
  const resume = session.cliSessionId != null
  const cliSessionId = session.cliSessionId ?? randomUUID()
  const seed = resume ? bodies.join('\n\n') : renderSessionSeed(session.threadId, bodies)
  const trigger: AgentRunTrigger = opts.from.kind === 'profile' ? 'delegation' : 'user-message'
  const { runId } = await startAgentRun(session.profileId, {
    trigger,
    thread: seed,
    model: opts.model,
    interactive: true, // the D-014 park machinery IS the live path
    // A.3: sessionId stamp — startAgentRun does not accept a `sessionId` opt yet;
    // A.3 adds it (threaded to startRun → runs.session_id) alongside runs.kind.
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
 *  boundary — a body is never dropped WHILE THE ATTACHMENT LIVES. Bodies still
 *  queued when the run reaches terminal are stranded in A.1 (documented at
 *  finalizeSessionTerminal; A.2's terminal re-dispatch closes it). */
function drainPending(att: Attachment): void {
  if (att.pending.length === 0) return
  const combined = att.pending.splice(0).join('\n\n')
  if (!sendInput(att.runId, combined)) att.pending.push(combined)
}

/**
 * Terminal state rules — the A.1 subset (A.2 replaces this with the full set:
 * resume-rejected → 'stale' + id clear, undo taint, forcedState):
 *  - 'done' → 'resumable'; an ESTABLISH that never INITed additionally stamps
 *    its own sessionId (belt-and-suspenders D-062 — the INIT stamp is primary,
 *    and a resume never overwrites the id it resumed).
 *  - non-done WITH INIT observed → 'resumable': a REAL CLI session exists — its
 *    id was persisted at the INIT event, so a mid-turn death (error/kill) keeps
 *    the context and the next send resumes it. Covers establish AND resume —
 *    exactly the continuity the INIT-time persist exists for.
 *  - non-done ESTABLISH without INIT → 'stale' (cli_session_id still NULL): no
 *    CLI session ever came up — the next send reseeds cleanly.
 *  - non-done RESUME without INIT → 'resumable' in A.1 (W0 parity: the resume
 *    retries); A.2's resume-rejected rule turns EXACTLY this case into 'stale'
 *    + id clear.
 * context_tokens refreshes on every terminal (the run's last observed size).
 * PENDING STRAND (A.1, documented): bodies still queued at terminal are NOT
 * re-sent — their durable turns survive and fold into a later ESTABLISH's seed
 * replay, but a RESUME will not carry them. A.2's terminal re-dispatch closes
 * this.
 */
function finalizeSessionTerminal(sessionId: string, att: Attachment, status: string): void {
  const now = Date.now()
  updateSessionContextTokens(sessionId, att.runId)
  if (status === 'done') {
    if (!att.initSeen && !att.resume) {
      agentSessionsDb.setCliSessionId.run(att.cliSessionId, now, sessionId)
    }
    agentSessionsDb.setState.run('resumable', now, sessionId)
    agentSessionsDb.touch(sessionId, now)
  } else if (att.initSeen) {
    agentSessionsDb.setState.run('resumable', now, sessionId)
  } else if (!att.resume) {
    agentSessionsDb.setState.run('stale', now, sessionId)
  } else {
    agentSessionsDb.setState.run('resumable', now, sessionId)
  }
}

// ── demotion + counters ───────────────────────────────────────────────────────

/**
 * Demote a session — still the W0-pure state transition in A.1 (A.2 adds the
 * real live-process demotion: graceful stdin close, boot sweep, LRU eviction).
 * 'error' → 'stale' from any state; 'idle'/'boot'/'lru' → 'resumable' only when
 * currently 'live' (a no-op otherwise). Writes go through the agentSessionsDb
 * helpers so updated_at always advances. An unknown id is a silent no-op:
 * demotion is idempotent housekeeping called from sweeps/timers.
 */
export function demoteSession(sessionId: string, reason: 'idle' | 'boot' | 'lru' | 'error'): void {
  const row = agentSessionsDb.get.get(sessionId) as Row | undefined
  if (!row) return
  const now = Date.now()
  if (reason === 'error') {
    agentSessionsDb.setState.run('stale', now, sessionId)
    return
  }
  if (String(row.state) === 'live') agentSessionsDb.setState.run('resumable', now, sessionId)
}

/** How many sessions currently hold state 'live'. A full-row list is fine at
 *  this scale (bounded by MAX_LIVE_SESSIONS once A.2 enforces the cap). */
export function liveSessionCount(): number {
  return (agentSessionsDb.listByState.all('live') as Row[]).length
}
