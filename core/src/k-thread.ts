/**
 * K front-door runtime (D-023) — persistent identity (the durable thread is the
 * SOURCE OF TRUTH), cheap execution. Each K ask is a RESUMABLE ONE-SHOT run (W7a,
 * design A): the FIRST ask establishes a stable CLI session (`--session-id`) seeded
 * from the thread; every LATER ask CONTINUES it (`--resume`) sending ONLY the new
 * message — so continuity comes from a cheap cache-read of the session, not a held
 * warm process or a replayed 12-turn transcript. A one-shot ANSWERS AND EXITS: it
 * never parks at awaiting_input holding a process/worktree (fixes F-054 cost/park
 * and H10 self-terminate), and K needs no code worktree. The `renderSeed` transcript
 * replay survives ONLY as the fallback for a truly-fresh/reset session (no session id).
 *
 * SDK-free, like mcp/logistics.ts: no Fastify/transport import, so it is unit-
 * testable directly against the DB + EventBus. The route layer (routes/k.ts) is a
 * thin adapter over askK / undoK / ensureDefaultKThread / listKThreadTurns.
 */
import { randomUUID } from 'crypto'
import { v4 as uuid } from 'uuid'
import type { KThread, KThreadTurn, KAskResult, KRoute, KForceRoute } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { kThreadsDb, runsDb, eventsDb, mgmtDb, db } from './db.js'
import { eventBus } from './events.js'
import { startAgentRun } from './agent-runs.js'
import { kill } from './supervisor.js'
import { leadRosterHint } from './chief-dispatch.js'
import { isTerminalRunStatus, trackSupervisedRun } from './run-lifecycle.js'

/** The singleton default K thread — the one front-door conversation for now. */
export const DEFAULT_K_THREAD_ID = 'k-default'

/** How many recent turns to fold into a cold reseed (bounded so the prompt stays small). */
const SEED_TURN_WINDOW = 12

/** The routing/behavior instruction appended to a cold reseed. */
const K_SEED_INSTRUCTION =
  '(You are K, the secretary front door. Handle logistics/Q&A/scheduling/notes/tasks yourself; ' +
  'otherwise route engineering to the Chief or a named lead, stating the route first. Pick the right ' +
  'store by intent: a note/FYI/"jot this down" → note_add (Notes); a "schedule …"/"remind me …"/a time ' +
  "→ event_add or reminder_add (Schedule); a task/to-do/\"track this\" → work_item_create scope='personal' " +
  "(org items scope='org', persisting across sessions). An ambiguous \"add a note\" is a NOTE, not a task.)"

// ── row → type mappers (snake_case → camelCase) ──────────────────────────────

type Row = Record<string, unknown>

/** Row → KThread mapper (snake_case → camelCase). Exported so the thread-list route
 *  (routes/k.ts GET /api/k/threads) can reuse it directly on the joined listThreads
 *  rows instead of duplicating the mapping. */
export function rowToKThread(r: Row): KThread {
  return {
    id: String(r.id),
    title: r.title == null ? null : String(r.title),
    status: r.status as KThread['status'],
    activeRunId: r.active_run_id == null ? null : String(r.active_run_id),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function rowToKThreadTurn(r: Row): KThreadTurn {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    role: r.role as KThreadTurn['role'],
    text: String(r.text),
    runId: r.run_id == null ? null : String(r.run_id),
    createdAt: Number(r.created_at),
  }
}

// ── thread + turn accessors ──────────────────────────────────────────────────

/** Get a K thread by id, or null. */
export function getKThread(id: string): KThread | null {
  const r = kThreadsDb.getThread.get(id) as Row | undefined
  return r ? rowToKThread(r) : null
}

/** Get-or-create the singleton default K thread (idempotent). */
export function ensureDefaultKThread(): KThread {
  const existing = getKThread(DEFAULT_K_THREAD_ID)
  if (existing) return existing
  const now = Date.now()
  kThreadsDb.insertThread.run({
    id: DEFAULT_K_THREAD_ID,
    title: null,
    status: 'active',
    activeRunId: null,
    createdAt: now,
    updatedAt: now,
  })
  // Non-null: we just inserted it.
  return getKThread(DEFAULT_K_THREAD_ID)!
}

/** Thrown when an explicit thread id (resolveAskThread, or a direct route lookup)
 *  does not exist — the route layer maps this to 404. */
export class KThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`k thread not found: ${id}`)
  }
}

/** Create a new, empty K thread (title null; backfilled from the first ask — see
 *  the title-on-first-send step in {@link askK}). */
export function createKThread(): KThread {
  const id = `kt-${uuid().slice(0, 8)}`
  const now = Date.now()
  kThreadsDb.insertThread.run({ id, title: null, status: 'active', activeRunId: null, createdAt: now, updatedAt: now })
  // Non-null: we just inserted it.
  return getKThread(id)!
}

/**
 * Resolve the thread an ask (or the legacy GET /api/k/thread) targets. An explicit
 * `threadId` must exist (throws {@link KThreadNotFoundError} otherwise — the route
 * layer 404s); with none given, defaults to the most-recently-updated NON-archived
 * thread (kThreadsDb.listThreads is already updated_at DESC), falling back to
 * {@link ensureDefaultKThread} when there is no such thread (a wholly empty/all-
 * archived DB) — so a fresh install's first ask still works with zero threads.
 * If that fallback lands on an ARCHIVED default thread (possible once PATCH can
 * archive any thread), it is un-archived first: a thread receiving new activity
 * must be visible in the non-archived list, or the message would land hidden.
 */
export function resolveAskThread(threadId?: string): KThread {
  if (threadId) {
    const t = getKThread(threadId)
    if (!t) throw new KThreadNotFoundError(threadId)
    return t
  }
  const rows = kThreadsDb.listThreads.all() as Array<{ id: string; archived_at: number | null }>
  const recent = rows.find(r => r.archived_at == null)
  if (recent) return getKThread(recent.id)!
  const fallback = ensureDefaultKThread()
  if (fallback.archivedAt == null) return fallback
  kThreadsDb.setThreadArchived.run(null, Date.now(), fallback.id)
  return getKThread(fallback.id)!
}

/** The thread's turns, oldest-first. */
export function listKThreadTurns(id: string): KThreadTurn[] {
  const rows = kThreadsDb.listTurns.all(id) as Row[]
  return rows.map(rowToKThreadTurn)
}

/** Append a turn to a thread. `runId` links the turn to the run that produced/
 *  received it (null until known — patched later on the fresh/warm path). */
export function appendTurn(
  threadId: string,
  role: KThreadTurn['role'],
  text: string,
  runId: string | null = null,
): KThreadTurn {
  const id = randomUUID()
  kThreadsDb.insertTurn.run({ id, threadId, role, text, runId, createdAt: Date.now() })
  return rowToKThreadTurn(kThreadsDb.getTurn.get(id) as Row)
}

// ── seed rendering (cold start) ──────────────────────────────────────────────

/**
 * Render the cold-start seed for a fresh K run: the last {@link SEED_TURN_WINDOW}
 * durable turns as `You:` / `K:` lines, then the current `You: <message>` line, then
 * a short routing instruction. Bounded so the reseed prompt stays small.
 *
 * askK persists the current user turn (line 194) BEFORE calling this, so the newest
 * turn is already the last row `listKThreadTurns` returns. We slice it OFF the history
 * window (`…, -1`) so the current message appears exactly ONCE — as the explicit
 * trailing line — instead of being doubled (history tail + trailing line). This keeps
 * the "durable before dispatch" guarantee while giving the agent a single crisp ask.
 */
export function renderSeed(threadId: string, message: string): string {
  const recent = listKThreadTurns(threadId).slice(-(SEED_TURN_WINDOW + 1), -1)
  const lines = recent.map(t => `${t.role === 'user' ? 'You' : 'K'}: ${t.text}`)
  lines.push(`You: ${message}`)
  lines.push(K_SEED_INSTRUCTION)
  return lines.join('\n')
}

// ── answer capture (K's replies → durable thread) ────────────────────────────

/**
 * Run ids whose ask was UNDONE this session (F-060). undoK kills the run + deletes its
 * turns, but the kill is fire-and-forget: the dying process can still flush a late
 * terminal/assistant event, and captureAnswers' (and reportDelegationBack's) run-update
 * subscribers are NOT torn down on undo. Without a gate, that late flush would append an
 * orphaned `k` reply for a run whose `user` ask is already gone — the exact "undone
 * message re-appears" hazard undo exists to prevent. Mirrors supervisor's `killedRuns`
 * idiom. Bounded by undo frequency (a rare, explicit user action); ids are never reused.
 */
const undoneRuns = new Set<string>()

/**
 * Whether a `k` reply for `runId` must be SUPPRESSED before it is appended to a thread.
 * Primary gate: the ask was explicitly undone this session. Belt-and-suspenders backstop
 * (self-cleaning, survives a missed gate): if the run's own `user` ask turn no longer
 * exists on any thread, a `k` reply for it would be orphaned regardless — so suppress it.
 * A NORMAL captureAnswers / reportDelegationBack run always has a live `user` turn linked
 * to its run_id (askK/delegateToChief patch it on before dispatch), so this only trips for
 * a removed (undone) ask. Deliberately NOT applied to continueLeadOutcomeToK, whose `k`
 * turn links to the LEAD run (which never has a user turn) and which is already gated by
 * resolveKDelegationThread — undo deletes the Chief user turn, breaking that link.
 */
function kReplySuppressed(runId: string): boolean {
  if (undoneRuns.has(runId)) return true
  return kThreadsDb.hasUserTurnForRun.get(runId) == null
}

/**
 * Subscribe to run updates for `runId` and capture K's answers back onto the thread
 * at each turn boundary, so a later reseed stays coherent (K remembers its own
 * replies, not just the user's asks). On each update for this run that is awaiting
 * input OR terminal, read the run's `assistant` events with seq > lastSeq, concat
 * their text, and append a `k` turn if non-empty; advance lastSeq. On a terminal
 * status, unsubscribe FIRST then clear the thread's active run (status → idle),
 * once — mirroring run-lifecycle's unsub-before-write + once-latch discipline so a
 * duplicate terminal event can't double-clear. (A one-shot K ask has a single
 * terminal boundary; the awaiting_input branch stays for any interactive reuse.)
 *
 * W7a: `sessionIdToPersist`, when supplied (the FIRST ask, whose run was launched with
 * `--session-id <it>`), is stamped onto the thread as `cli_session_id` ONLY on a
 * SUCCESSFUL terminal ('done'). Persisting on success — not upfront — means an undone,
 * killed, or fast-failed first ask never records a session that `--resume` would then
 * miss or that would carry an undone message forward: the next ask cleanly starts fresh.
 * The `IS NULL` guard in the statement makes the write idempotent.
 */
export function captureAnswers(threadId: string, runId: string, sessionIdToPersist?: string): void {
  let lastSeq = 0
  let done = false

  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== runId) return
    const terminal = isTerminalRunStatus(r.status)

    if (r.status === 'awaiting_input' || terminal) {
      // Seq-windowed, assistant-only read (no raw column, no full-log scan): the
      // statement returns ONLY the new assistant rows since the last boundary, seq
      // ASC, so lastSeq advances to the last row's seq.
      const rows = eventsDb.listAssistantEventsAfterSeq.all(runId, lastSeq) as Row[]
      const parts: string[] = []
      for (const row of rows) {
        const text = row.text == null ? '' : String(row.text)
        if (text.length > 0) parts.push(text)
      }
      if (rows.length > 0) lastSeq = Number(rows[rows.length - 1].seq)
      const concat = parts.join('\n')
      // Suppress a reply for an UNDONE ask (F-060): a late flush from the killed run
      // must not resurrect an orphaned `k` turn after undoK removed the `user` ask.
      if (concat.length > 0 && !kReplySuppressed(runId)) appendTurn(threadId, 'k', concat, runId)
    }

    if (terminal) {
      if (done) return // once-latch: a duplicate terminal can't double-clear
      done = true
      // Unsub BEFORE the write so a duplicate terminal delivered in the same tick
      // can't re-enter and clear twice.
      unsub()
      const now = Date.now()
      // Persist the stable CLI session id ONLY on a successful first ask, so later
      // asks can `--resume` it. A non-'done' terminal (undo/kill/error) leaves it NULL.
      if (sessionIdToPersist != null && r.status === 'done') {
        kThreadsDb.setThreadCliSessionId.run(sessionIdToPersist, now, threadId)
      }
      kThreadsDb.updateThreadActiveRun.run(null, now, threadId)
      kThreadsDb.updateThreadStatus.run('idle', now, threadId)
    }
  })

  // Backstop the await/subscribe race (mirrors run-lifecycle.ts): a fast-failing run
  // (bad config, `claude` not found, immediate error exit) can reach terminal BEFORE
  // we subscribed above — the terminal run_update already fired with no listener. If
  // we only subscribed we'd leak the subscriber and leave the thread's active_run_id
  // pointing at a dead run forever. So re-read the run's current status and, if it is
  // already terminal, clear the thread now (once). No final-answer capture on this
  // path — a run that died this fast produced no answer to record.
  const currentStatus = (runsDb.getRun.get(runId) as { status?: string } | undefined)?.status
  if (isTerminalRunStatus(currentStatus) && !done) {
    done = true
    unsub()
    const now = Date.now()
    kThreadsDb.updateThreadActiveRun.run(null, now, threadId)
    kThreadsDb.updateThreadStatus.run('idle', now, threadId)
  }
}

// ── delegation (K → Chief, D-046) ─────────────────────────────────────────────

/**
 * Build the Chief's delegation seed from the operator's ask + the deterministic
 * route. When the route named a discipline lead (frontend/backend/…), pass that hint
 * through so the Chief can `assign_lead` the right lead; a bare `chief` route leaves
 * the lead choice to the Chief. Pure + exported so a test can assert the seed carries
 * the ask verbatim.
 */
export function buildDelegationGoal(message: string, route: KRoute): string {
  // F-067: a bare `chief` route names no discipline, so inject the full lead roster — the
  // Chief always knows the valid lead identifiers to assign_lead against (never an invented
  // "engineering"). A named-lead route already points at a discipline, so it keeps its hint.
  const hint =
    route.target === 'chief'
      ? ` ${leadRosterHint()}`
      : ` The operator's request points at the ${route.target} discipline` +
        ` (route preview: ${route.label}); assign the appropriate lead if it fits.`
  return (
    `Delegated from K (the secretary) on the operator's behalf: "${message}".${hint}` +
    ' Break it down, assign the right lead, and file a concise status report up the chain.'
  )
}

/** Max length of BOTH report-back bodies on K's thread — the Chief's mgmt-report
 *  text AND the assistant-text fallback — so a verbose Chief run can't dump a huge
 *  transcript (the mgmt `report` zod max is 20k; both hops share this 2000 cap). */
const REPORT_BACK_TEXT_CAP = 2_000

/** How many of the run's earliest `assistant` events the fallback scans (seq ASC) —
 *  enough to fill the 2k cap without materializing a long run's whole event log.
 *  Mirrors chief-dispatch.ts::LEAD_REPORT_EVENT_SCAN (the lead-side twin). */
const REPORT_BACK_EVENT_SCAN = 50

/** Concatenate a bounded prefix of a run's `assistant` event texts (oldest→newest,
 *  up to REPORT_BACK_EVENT_SCAN events), capped — the delegated run's own final
 *  answer, the report-back fallback when the Chief filed no mgmt report. Capped
 *  rather than windowed like captureAnswers: this is a one-shot summary, not a
 *  stateful turn-by-turn capture. NB a run with more than REPORT_BACK_EVENT_SCAN
 *  assistant events loses the tail (the scan is a prefix, not a suffix) — accepted
 *  for a summary hop, and it mirrors the lead-side twin exactly. */
function concatAssistantText(runId: string): string {
  const rows = eventsDb.listAssistantEvents.all(runId, REPORT_BACK_EVENT_SCAN) as Row[]
  const parts: string[] = []
  for (const row of rows) {
    const text = row.text == null ? '' : String(row.text)
    if (text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n')
  return joined.length > REPORT_BACK_TEXT_CAP ? `${joined.slice(0, REPORT_BACK_TEXT_CAP)}…` : joined
}

/** The run's CONCLUSION — its final (last) non-empty `assistant` event text, capped. F-075:
 *  the lead-continuation report-back uses this TAIL (the lead's final message, e.g. "Opened
 *  PR #7; CI green.") instead of concatAssistantText's PREFIX scan, which loses the
 *  conclusion by truncating the opening turns. */
function finalAssistantText(runId: string): string {
  const row = eventsDb.latestAssistantEvent.get(runId) as Row | undefined
  const text = row?.text == null ? '' : String(row.text)
  return text.length > REPORT_BACK_TEXT_CAP ? `${text.slice(0, REPORT_BACK_TEXT_CAP)}…` : text
}

/**
 * Summarize a delegated Chief run's outcome for the report-back turn. Prefers the
 * Chief's latest mgmt `report` (the status written UP the chain), falling back to the
 * run's own assistant text, then to a bare status line — so the operator always sees
 * *something* land where they asked, even if the Chief filed no formal report.
 */
export function summarizeDelegatedOutcome(childRunId: string, status: string): string {
  const verb = status === 'done' ? 'completed' : status
  const reports = mgmtDb.listReportsByRun.all(childRunId, 1) as Row[]
  const reportBody = reports.length > 0 ? String(reports[0].body) : ''
  if (reportBody.length > 0) {
    // Same cap as the fallback: the mgmt `report` zod max is 20k — never dump that
    // raw onto K's thread.
    const capped =
      reportBody.length > REPORT_BACK_TEXT_CAP
        ? `${reportBody.slice(0, REPORT_BACK_TEXT_CAP)}…`
        : reportBody
    return `Chief (delegation ${verb}) reported: ${capped}`
  }
  const answer = concatAssistantText(childRunId)
  if (answer.length > 0) return `Chief (delegation ${verb}): ${answer}`
  return `Chief delegation ${verb} — no report was filed.`
}

/**
 * Report a delegated Chief run's outcome back UP onto K's thread. Rides the shared
 * run-lifecycle seam (trackSupervisedRun) exactly like startAgentRun's own tracking:
 * on the child run's terminal — once, race-backstopped — it appends a `k` turn
 * summarizing the outcome, linked to the child run so the report-back is itself part
 * of the traceable delegation chain. It does NOT touch the thread's active_run_id
 * (that belongs to K's own warm session, a separate concern from a delegated run).
 */
export function reportDelegationBack(threadId: string, childRunId: string): void {
  trackSupervisedRun(childRunId, {
    onStarted: () => { /* runId already known — nothing to patch */ },
    finalize: status => {
      // Same undo gate as captureAnswers (F-060): if the operator undid this delegation
      // (kill + turn-delete), the Chief run's terminal must not append an orphaned report.
      if (kReplySuppressed(childRunId)) return
      appendTurn(threadId, 'k', summarizeDelegatedOutcome(childRunId, status), childRunId)
    },
  })
}

// ── Chief→K continuation (loop-b2 — complete the up-chain) ────────────────────
//
// reportDelegationBack (above) surfaces the CHIEF run's outcome when the CHIEF run
// terminates. But a Chief's bounded activation can end BEFORE the lead it dispatched
// finishes — so that report can be PRE-lead (the lead's real outcome isn't up the chain
// yet). This seam closes the gap: it rides the LEAD run's terminal (the same main-EventBus
// signal chief-dispatch.ts::reportLeadOutcomeToChief uses to file the lead→Chief mgmt
// report) and continues the lead's outcome one more hop UP — onto K's durable thread —
// so the full K→Chief→lead chain lands where the operator asked.

/**
 * Resolve the K thread that DELEGATED a given Chief run, or null. The K→Chief link is
 * derivable with NO new table: delegateToChief patches the Chief run id onto the operator's
 * user turn (and the ack turn), so a k_thread_turns row whose run_id = chiefRunId identifies
 * the delegating thread. Null ⇒ the Chief run was NOT a K delegation (it woke autonomously
 * via chief-wake, which never touches k_thread_turns) — so there is nothing to continue up.
 */
export function resolveKDelegationThread(chiefRunId: string): string | null {
  const row = kThreadsDb.getThreadIdByTurnRunId.get(chiefRunId) as Row | undefined
  return row ? String(row.thread_id) : null
}

/**
 * Summarize a dispatched LEAD run's terminal outcome for the continuation turn on K's
 * thread. F-075: prefers a CONCISE signal — the lead's own mgmt `report` when it filed one
 * (mirroring summarizeDelegatedOutcome) — else the lead's CONCLUSION (final assistant
 * message, the TAIL, not the opening-turns prefix); else a bare status line. Pure +
 * exported so a test can assert the phrasing.
 */
export function summarizeChiefLeadContinuation(leadRunId: string, lead: string, status: string): string {
  const verb = status === 'done' ? 'completed' : status
  // Prefer the lead's explicit mgmt report over raw transcript text.
  const reports = mgmtDb.listReportsByRun.all(leadRunId, 1) as Row[]
  const reportBody = reports.length > 0 ? String(reports[0].body) : ''
  if (reportBody.length > 0) {
    const capped =
      reportBody.length > REPORT_BACK_TEXT_CAP ? `${reportBody.slice(0, REPORT_BACK_TEXT_CAP)}…` : reportBody
    return `Chief (via ${lead}) ${verb} reported: ${capped}`
  }
  const answer = finalAssistantText(leadRunId)
  return answer.length > 0
    ? `Chief (via ${lead}) ${verb}: ${answer}`
    : `Chief (via ${lead}) ${verb} — no summary was produced.`
}

/**
 * Continue a dispatched lead's outcome UP onto K's thread (the final hop of the up-chain).
 * Rides the shared run-lifecycle seam on the LEAD run: on the lead's terminal — once,
 * race-backstopped — IF the parent Chief run was itself a K delegation (a k_thread_turn links
 * it to a thread), it appends a `k` turn summarizing the lead's outcome, linked to the lead
 * run so the continuation is part of the traceable chain. If the Chief woke autonomously (no
 * linked thread) it is a no-op — the lead outcome stays in the Chief's mgmt store only.
 * Deliberately independent of reportLeadOutcomeToChief (each rides its own once-latched
 * subscriber on the same lead terminal), mirroring reportDelegationBack's shape.
 */
export function continueLeadOutcomeToK(chiefRunId: string, leadRunId: string, lead: string): void {
  trackSupervisedRun(leadRunId, {
    onStarted: () => { /* runId already known — nothing to patch */ },
    finalize: status => {
      const threadId = resolveKDelegationThread(chiefRunId)
      if (threadId == null) return // Chief woke autonomously — nothing to continue up to K.
      appendTurn(threadId, 'k', summarizeChiefLeadContinuation(leadRunId, lead, status), leadRunId)
    },
  })
}

/**
 * Hand an engineering-routed ask UP to the Chief (D-046). K does NOT run it itself:
 * it activates `startAgentRun('chief', { trigger:'delegation', goal })`, records an
 * acknowledgment turn linked to the Chief run (which — with the child's
 * `agent_runs.trigger='delegation'` — makes the K→Chief parent→child link derivable
 * from the existing `k_thread_turns.run_id` FK, no new table), and wires the
 * report-back so the Chief's outcome lands on this thread when its run terminates. A
 * dispatch throw propagates (startAgentRun already rolled its tracking row back to
 * 'failed'); the durable user turn stays, mirroring the cold path.
 */
async function delegateToChief(
  thread: KThread,
  message: string,
  route: KRoute,
  userTurn: KThreadTurn,
  model?: string,
): Promise<KAskResult> {
  const goal = buildDelegationGoal(message, route)
  // Deliberate: an operator-initiated delegation dispatches the Chief DIRECTLY, NOT via
  // chief-wake's wakeChief — so it is intentionally NOT subject to the autonomous-wake
  // debounce (Guard A) or the one-at-a-time already-running guard (Guard B). Those guards
  // exist to keep the AUTONOMOUS loop bounded; silently dropping or debouncing an explicit
  // human ask would be worse. mgmt rows are per-run_id scoped, so a concurrent chief run
  // can't corrupt another's store; the self-wake guard still stops this run's terminal from
  // re-waking the Chief (its agent_runs.profile_id === 'chief').
  const { agentRunId, runId } = await startAgentRun('chief', { trigger: 'delegation', goal, model })
  // Link the ask to the Chief run (the durable parent→child delegation record) and
  // acknowledge the hand-up on the thread so the operator sees the route was taken.
  kThreadsDb.patchTurnRunId.run(runId, userTurn.id)
  appendTurn(thread.id, 'k', `Routing to ${route.label}: "${message}"`, runId)
  // Report the Chief's terminal outcome back up onto this thread.
  reportDelegationBack(thread.id, runId)
  return { kThreadId: thread.id, agentRunId, runId, route, warm: false }
}

// ── the front door ───────────────────────────────────────────────────────────

/**
 * Activate K for one message (D-023). Records the user's ask as a durable turn (the
 * source of truth), then routes it: an engineering-routed ask is DELEGATED up to the
 * Chief (D-046, `startAgentRun('chief', {trigger:'delegation'})` + report-back);
 * otherwise K handles it itself as a RESUMABLE ONE-SHOT run (W7a, design A) — the
 * FIRST ask establishes a stable CLI session (`--session-id`) seeded from the thread,
 * every LATER ask RESUMES it (`--resume`) sending ONLY the new message. The run answers
 * and EXITS (no park, no held worktree). Returns the thread id, the run id, the
 * deterministic route PREVIEW, and `warm` (kept for API compatibility; always false —
 * continuity is now the resumed session, not a held warm process).
 *
 * Power controls (C2): `opts.forceRoute` bypasses the classifier — the route is
 * routeForTarget(forceRoute), always escalating (so a forced ask always delegates);
 * `opts.model` is an explicit per-ask model override threaded to startAgentRun. With
 * design A a model override no longer forfeits continuity: there is no live process to
 * keep, so the ask simply RESUMES the same session under the chosen model.
 *
 * Multi-thread (UI Simplification): `opts.threadId` targets a specific thread via
 * {@link resolveAskThread} — an explicit unknown id throws {@link KThreadNotFoundError}
 * (the route layer 404s, BEFORE any turn is appended); omitted, it resolves to the
 * most-recent non-archived thread as before. A thread's still-untitled first ask
 * stamps its title from the message (see below) so a freshly created thread shows
 * something in a thread list without a separate rename step.
 */
export async function askK(
  message: string,
  opts: { forceRoute?: KForceRoute; model?: string; threadId?: string } = {},
): Promise<KAskResult> {
  const thread = resolveAskThread(opts.threadId)
  // A forced route wins over the classifier — routeForTarget is the SAME shared
  // mapping the composer previews, so the forced preview and this decision agree.
  const route = opts.forceRoute ? routeForTarget(opts.forceRoute) : routeForMessage(message)

  // The durable ask — recorded up front so it survives even if the dispatch below
  // throws (startAgentRun rolls back only its own agent_runs row; the ask stays,
  // which is acceptable: the thread is the source of truth for what was asked).
  const turn = appendTurn(thread.id, 'user', message, null)
  // Title-on-first-send: a freshly created thread (POST /api/k/threads) has no
  // title; stamp one from the operator's first message so the thread list has
  // something to show. Guarded on title == null, so it only ever fires once.
  if (thread.title == null) kThreadsDb.setThreadTitle.run(message.slice(0, 60), Date.now(), thread.id)

  // Delegation path (D-046): an engineering-routed ask (Chief or a named lead) hands
  // UP to the Chief instead of K running it. Checked BEFORE the resumable path — a
  // hand-up is independent of K's own session — so logistics/Q&A keeps the K path below.
  if (route.escalates) {
    return delegateToChief(thread, message, route, turn, opts.model)
  }

  // K handles it itself as a resumable one-shot. Read the thread's stable CLI session id:
  //   NULL ⇒ a FIRST/reset session — generate one, ESTABLISH it (--session-id) and seed
  //          with the full renderSeed transcript (the fallback replay for a fresh session);
  //   set  ⇒ RESUME it (--resume) sending ONLY the new message. The resumed session already
  //          holds the history, so we neither re-pay the CLI envelope nor replay the transcript.
  const existing = (kThreadsDb.getThreadCliSessionId.get(thread.id) as { cli_session_id?: string | null } | undefined)?.cli_session_id
  const resume = existing != null
  const sessionId = existing ?? randomUUID()
  const seed = resume ? message : renderSeed(thread.id, message)

  const { agentRunId, runId } = await startAgentRun('k-secretary', {
    trigger: 'user-message',
    thread: seed,
    model: opts.model,
    persistentSession: { key: thread.id, sessionId, resume },
  })
  kThreadsDb.updateThreadActiveRun.run(runId, Date.now(), thread.id)
  kThreadsDb.patchTurnRunId.run(runId, turn.id)
  // Capture K's reply on terminal; on a FIRST ask, persist the session id on success so
  // the NEXT ask resumes it (resume ⇒ already persisted, so nothing to re-stamp).
  captureAnswers(thread.id, runId, resume ? undefined : sessionId)
  return { kThreadId: thread.id, agentRunId, runId, route, warm: false }
}

/**
 * Null a thread's stable CLI session id on undo (F-054/F-060). No such statement lives in
 * kThreadsDb (setThreadCliSessionId only WRITES onto a NULL, it never clears), so it is
 * prepared here. Keyed on the thread's PK `id`, NOT `active_run_id`: captureAnswers nulls
 * active_run_id on ANY terminal (done/killed/error), and a fast one-shot resume-ask commonly
 * reaches terminal INSIDE the 5s undo toast window — so by undo time active_run_id is already
 * gone and an active_run_id-keyed clear would match ZERO rows and LEAK the taint. Thread-keyed
 * errs SAFE: over-clearing at worst forces the next ask to re-seed from the already-cleaned
 * durable thread (a cheap resume becomes a full seed); it never leaks an undone message.
 */
const clearThreadCliSessionByThreadId = db.prepare(
  `UPDATE k_threads SET cli_session_id = NULL, updated_at = ? WHERE id = ?`,
)

/**
 * Undo a just-started K ask (F-060): kill the run AND remove the turns it appended,
 * so an undone message is never replayed into a later seed/resume. askK appends the
 * user turn BEFORE dispatch (the thread is the source of truth), so an undo that only
 * killed the run would leave that `user` turn (plus any partial `k` reply) dangling on
 * the thread — replayed into the next fresh reseed and shown forever in the UI. This
 * deletes every k_thread_turns row linked to the run, clears a thread stranded pointing
 * at it, AND nulls the OWNING thread's stable CLI session id (`cli_session_id`).
 *
 * The session-id clear closes the RESUME-ask taint (F-054/F-060): a LATER ask is dispatched
 * INTO the live CLI session via `claude -p <msg> --resume <sessionId>`, so removing only the
 * durable turns would leave the undone message alive in K's CLI context — resumable on the
 * next ask even though the transcript no longer shows it. (An undone FIRST ask that never
 * reached a successful terminal never persisted a session, so that case was already safe; a
 * first ask that DID reach 'done', or ANY resume ask, had one persisted, and this clears it.)
 * We resolve the owning thread from the run's turns BEFORE deleting them (the run→thread link
 * is unrecoverable once the rows are gone) and key the clear on the thread PK — NOT
 * active_run_id, which captureAnswers nulls on ANY terminal, so a fast one-shot that finished
 * inside the undo window would otherwise leave an active_run_id-keyed clear matching zero rows
 * and leak the taint. With the session gone the next ask reads `cli_session_id = NULL` →
 * resume=false → a full renderSeed re-seed from the ALREADY-cleaned durable thread, so the
 * undone turn can return through NEITHER the transcript NOR the resumed session. Over-clearing
 * errs safe (a cheap resume becomes a full seed); under-clearing would leak. (One benign
 * over-clear: undoing a Chief-DELEGATION ack — whose turn also links to the K thread — likewise
 * nulls that thread's session, so K's next self-ask re-seeds instead of resuming; harmless, and
 * a delegation was never part of K's own CLI session anyway.)
 * Best-effort + idempotent: a second undo of the same run simply finds nothing to remove.
 *
 * The kill is fire-and-forget (SIGTERM→SIGKILL, no await), so the dying process may flush
 * a late terminal/assistant event AFTER the turn-delete. We record the run id in
 * `undoneRuns` FIRST so the still-live captureAnswers / reportDelegationBack subscribers
 * suppress any reply for it (kReplySuppressed) instead of resurrecting an orphaned turn.
 */
export function undoK(runId: string): void {
  undoneRuns.add(runId) // gate late flushes BEFORE the kill can produce them
  kill(runId) // best-effort: no live process (already exited) → no-op
  const now = Date.now()
  // Resolve the owning thread from the run's turns BEFORE the delete removes them; no turns
  // ⇒ nothing to clean (no-op). Same run→thread derivation resolveKDelegationThread uses.
  const owning = kThreadsDb.getThreadIdByTurnRunId.get(runId) as Row | undefined
  kThreadsDb.deleteTurnsByRunId.run(runId)
  // Null the (possibly tainted) CLI session on the OWNING thread, keyed on its PK — not
  // active_run_id, which captureAnswers has already nulled if the run reached terminal (the
  // common fast-one-shot-then-undo path). So the next ask re-seeds fresh from the cleaned
  // durable thread instead of `--resume`-ing the undone message.
  if (owning) clearThreadCliSessionByThreadId.run(now, String(owning.thread_id))
  kThreadsDb.clearThreadActiveRunByRunId.run(now, runId)
}
