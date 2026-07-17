/**
 * Agent sessions — the FROZEN session-engine interface + the W0 interim adapter
 * (Continuous Agents W0.3, D-122).
 *
 * THE CONTRACT IS FROZEN: Lanes A/B/C build against these exact exported
 * signatures (getOrCreateConversation / ensureSession / sendToSession /
 * demoteSession / liveSessionCount / MAX_LIVE_SESSIONS and the MessageFrom /
 * SendResult shapes). Lane A replaces the INTERNALS with the hybrid live/stdin
 * runtime; the signatures must not change.
 *
 * WHAT W0 SHIPS (the interim adapter): today's K-secretary resumable one-shot
 * (k-thread.ts::askK, W7a design A) generalized to ANY profile. Each conversation
 * is a k_threads row (the durable source of truth); each (profile, thread) pair
 * has ONE agent_sessions row whose `home_dir` is a stable per-session directory
 * (agent-config.ts::agentSessionPaths) so the CLI's session files persist across
 * sends and `--resume` finds them. A send is: durable user turn first, then
 * establish (`--session-id`, seeded with a bounded neutral transcript replay) or
 * resume (`--resume`, body only) via startAgentRun's persistentSession — which
 * also makes the dispatch budget-exempt and plan-gate-exempt, exactly like K's
 * own asks. W0 never attaches a live process, so `SendResult.mode` is always
 * 'spawned' ('stdin' is Lane A's hybrid delivery) and no session ever enters
 * state 'live' from here.
 *
 * CONCURRENT-SEND POSTURE (accepted for W0, documented): sends to one session are
 * NOT serialized — two sends before the first 'done' both read cli_session_id
 * NULL and each establishes its own CLI session in the shared home_dir; the LAST
 * 'done' wins the setCliSessionId stamp and the loser's context is simply never
 * resumed (its answer still lands on the durable thread via captureAnswers).
 * This is exactly askK's inherited exposure (no active-run guard there either);
 * Lane A's live path owns real serialization. Likewise a resume against a
 * genuinely dead CLI session retries forever in W0 — plan A.2 (resume rejected →
 * 'stale' → renderSeed reseed) is Lane A's checklist item.
 *
 * SDK-free like k-thread.ts: no transport import, unit-testable directly against
 * the DB + EventBus.
 */
import { randomUUID } from 'crypto'
import type { KThread, AgentSession, AgentRunTrigger } from '@k/shared'
import { db, kThreadsDb, agentSessionsDb } from './db.js'
import { startAgentRun } from './agent-runs.js'
import { agentSessionPaths, assertSafeSegment } from './agent-config.js'
import { trackSupervisedRun } from './run-lifecycle.js'
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

/** How a send was delivered: 'spawned' = a new run was dispatched (the only W0
 *  mode); 'stdin' = delivered into a live parked run (Lane A's hybrid path). */
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

/** How many sessions may hold a live process at once (Lane A's LRU bound; unused
 *  by the W0 adapter itself, but frozen here so all lanes read ONE knob). */
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

/**
 * Render the establishing seed for a fresh/reset session: the last
 * {@link SESSION_SEED_TURN_WINDOW} durable turns as NEUTRAL `You:` / `Agent:`
 * lines, then the current `You: <body>` line. sendToSession persists the current
 * user turn BEFORE calling this, so the newest turn is sliced OFF the history
 * window (`…, -1`) and appears exactly once as the trailing line — the
 * k-thread.ts::renderSeed shape, minus K_SEED_INSTRUCTION: that instruction is
 * K-routing-specific (secretary store/route steering) and must not leak into an
 * arbitrary profile's seed. renderSeed itself stays the K-path fallback (plan
 * W0.3); this neutral replay is the generalized-session fallback.
 */
function renderSessionSeed(threadId: string, body: string): string {
  const recent = listKThreadTurns(threadId).slice(-(SESSION_SEED_TURN_WINDOW + 1), -1)
  const lines = recent.map(t => `${t.role === 'user' ? 'You' : 'Agent'}: ${t.text}`)
  lines.push(`You: ${body}`)
  return lines.join('\n')
}

/**
 * Send one message into a session — the W0 interim adapter: K's resumable
 * one-shot recipe (askK) run against the SESSION row instead of the thread row.
 *
 *  1. The durable `user` turn lands FIRST (the thread is the source of truth; it
 *     survives a dispatch throw, mirroring askK). A profile-sent message gets a
 *     `[from <profileId>] ` provenance prefix in the TURN TEXT ONLY — an interim
 *     visibility aid; Lane B owns real provenance (agent_messages rows) — the
 *     dispatch seed carries the raw body.
 *  2. cli_session_id NULL → ESTABLISH (a fresh `--session-id`, seeded with the
 *     neutral transcript replay); set → RESUME (`--resume`, body only).
 *  3. Dispatch via startAgentRun with persistentSession {key, sessionId, resume,
 *     homeDir} — homeDir (the session's stable home) is what generalizes the
 *     mechanics beyond K's k-secretary/<thread> namespace. Trigger: a user send
 *     is 'user-message'; a profile send is 'delegation' — the most honest member
 *     of today's AgentRunTrigger union for one profile handing a message to
 *     another (there is no 'message' trigger until Lane B).
 *  4. captureAnswers folds the reply onto the thread and clears the thread's
 *     active-run pointer on terminal — deliberately WITHOUT sessionIdToPersist:
 *     session-id ownership moves from k_threads to agent_sessions, so a separate
 *     terminal hook (trackSupervisedRun, the house seam) stamps the SESSION row:
 *     'done' → persist the CLI session id (when establishing) + 'resumable';
 *     any other terminal → an establishing session stays unpersisted + 'stale'
 *     (the next send reseeds fresh), a resuming session keeps its id +
 *     'resumable' (resume retries) — K's persist-only-on-success posture.
 *     Undo/kill taint handling stays Lane A scope.
 *
 * Always returns mode 'spawned' in W0 — 'stdin' arrives with Lane A's live path.
 */
export async function sendToSession(
  sessionId: string,
  body: string,
  opts?: { from?: MessageFrom; model?: string },
): Promise<SendResult> {
  const row = agentSessionsDb.get.get(sessionId) as Row | undefined
  if (!row) throw new AgentSessionNotFoundError(sessionId)
  const session = rowToAgentSession(row)

  const from: MessageFrom = opts?.from ?? { kind: 'user' }
  const turnText = from.kind === 'profile' ? `[from ${from.profileId}] ${body}` : body
  const turn = appendTurn(session.threadId, 'user', turnText, null)

  const resume = session.cliSessionId != null
  const cliSessionId = session.cliSessionId ?? randomUUID()
  const seed = resume ? body : renderSessionSeed(session.threadId, body)
  const trigger: AgentRunTrigger = from.kind === 'profile' ? 'delegation' : 'user-message'

  // A dispatch throw propagates unchanged (startAgentRun already rolled its
  // tracking row back to 'failed'); the durable user turn stays and the session
  // row is untouched — the next send simply tries the same establish/resume again.
  const { runId } = await startAgentRun(session.profileId, {
    trigger,
    thread: seed,
    model: opts?.model,
    persistentSession: { key: session.threadId, sessionId: cliSessionId, resume, homeDir: session.homeDir },
  })

  kThreadsDb.updateThreadActiveRun.run(runId, Date.now(), session.threadId)
  kThreadsDb.patchTurnRunId.run(runId, turn.id)
  captureAnswers(session.threadId, runId)

  trackSupervisedRun(runId, {
    onStarted: () => { /* runId already known — nothing to patch */ },
    finalize: status => {
      const now = Date.now()
      if (status === 'done') {
        // Persist-on-success (the W7a posture): only a send that ANSWERED records
        // the CLI session for later `--resume`. setCliSessionId is last-wins here
        // (unlike k_threads' write-once), which is what a re-seeded session needs.
        if (!resume) agentSessionsDb.setCliSessionId.run(cliSessionId, now, session.id)
        agentSessionsDb.setState.run('resumable', now, session.id)
        agentSessionsDb.touch(session.id, now)
      } else if (!resume) {
        // Establish failed/killed: nothing worth resuming — stay 'stale' with
        // cli_session_id NULL so the next send reseeds cleanly.
        agentSessionsDb.setState.run('stale', now, session.id)
      } else {
        // Resume failed/killed: the underlying CLI session is still intact —
        // keep its id and stay 'resumable' so the next send retries the resume.
        agentSessionsDb.setState.run('resumable', now, session.id)
      }
    },
  })

  // The send itself is session activity, independent of how the run ends.
  agentSessionsDb.touch(session.id, Date.now())
  return { mode: 'spawned', runId }
}

// ── demotion + counters ───────────────────────────────────────────────────────

/**
 * Demote a session — W0 interim: a PURE state transition, no process work (Lane A
 * adds the real live-process demotion: graceful stdin close, boot sweep, LRU
 * eviction). 'error' → 'stale' from any state; 'idle'/'boot'/'lru' → 'resumable'
 * only when currently 'live' (a no-op otherwise — the W0 adapter never creates
 * 'live', so these reasons only matter once Lane A lands). Writes go through the
 * agentSessionsDb helpers so updated_at always advances. An unknown id is a
 * silent no-op: demotion is idempotent housekeeping called from sweeps/timers.
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
 *  this scale (bounded by MAX_LIVE_SESSIONS once Lane A enforces the cap). */
export function liveSessionCount(): number {
  return (agentSessionsDb.listByState.all('live') as Row[]).length
}
