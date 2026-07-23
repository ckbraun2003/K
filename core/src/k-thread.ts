/**
 * K front-door runtime (D-023 → D-126, Continuous Agents A.4) — persistent
 * identity (the durable thread is the SOURCE OF TRUTH); execution rides the
 * SESSION ENGINE (agent-sessions.ts). askK resolves the thread and hands the
 * message to K's (k-secretary, thread) session: a live parked run receives it
 * over stdin (`warm: true`), else an interactive session run is spawned — the
 * establish/resume decision keys off the session row's cli_session_id, exactly
 * like every other conversable agent. K DECIDES IN CONTEXT now: the deterministic
 * router survives only as a display PREVIEW, and a FORCED route is an explicit
 * operator message QUEUED to the target agent's mailbox (agent_messages; Lane B's
 * relay delivers it). `renderSeed` survives as the documented stale-path fallback
 * seed for a truly-fresh/reset session.
 *
 * IMPORT NOTE (A.4): k-thread ↔ agent-sessions is a deliberate, benign ESM cycle
 * — askK rides ensureSession/sendToSession/undoSessionRun there; agent-sessions
 * rides appendTurn/captureAnswers/listKThreadTurns here. Every cross-reference is
 * call-time and both module bodies stay inert at load (the documented
 * agent-config ↔ run-assets precedent).
 *
 * SDK-free, like mcp/logistics.ts: no Fastify/transport import, so it is unit-
 * testable directly against the DB + EventBus. The route layer (routes/k.ts) is a
 * thin adapter over askK / undoK / ensureDefaultKThread / listKThreadTurns.
 */
import { randomUUID } from 'crypto'
import { v4 as uuid } from 'uuid'
import type { KThread, KThreadTurn, KAskResult, KForceRoute } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { kThreadsDb, runsDb, eventsDb, mgmtDb, pipelineDb, agentRunsDb, db, agentMessagesDb } from './db.js'
import { eventBus } from './events.js'
import { queueMessage } from './agent-mail.js'
import { kill } from './supervisor.js'
import { isTerminalRunStatus, trackSupervisedRun } from './run-lifecycle.js'
import { onPipelineTerminal } from './pipeline-engine.js'
import { ensureSession, sendToSession, undoSessionRun, getOrCreateConversation } from './agent-sessions.js'
import { getProfile } from './profiles.js'
import { domainForPipelineDef } from './domains.js'
import { ORG_DEFAULT_PROFILE_ID } from './plan-gate.js'

/** The singleton default K thread — the one front-door conversation for now. */
export const DEFAULT_K_THREAD_ID = 'k-default'

/** K's own profile id — the owner every K thread defaults to (k_threads.profile_id
 *  DEFAULT 'k-secretary', v16). Local copy per repo convention (agent-sessions.ts,
 *  agent-mail.ts each define their own rather than importing a shared constant). */
const K_SECRETARY_PROFILE_ID = 'k-secretary'

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
 * Resolve the thread an ask targets. An explicit `threadId` must exist (throws
 * {@link KThreadNotFoundError} otherwise — the route
 * layer 404s); with none given, defaults to the most-recently-updated NON-archived
 * K-OWNED thread (scoped to profile_id === 'k-secretary' via listByProfile, itself
 * updated_at DESC), falling back to {@link ensureDefaultKThread} when there is no
 * such thread (a wholly empty/all-archived DB) — so a fresh install's first ask
 * still works with zero threads. The k-secretary scope is load-bearing: askK is
 * K's own front door, so an unscoped fallback could otherwise silently adopt
 * another profile's most-recently-updated conversation as K's — a real risk now
 * that pipeline outcomes touch non-k-secretary threads on every completion.
 * Either path can land on an ARCHIVED thread (possible once PATCH can archive
 * any thread, including the one an explicit threadId names): that thread is
 * un-archived first — a thread receiving new activity must be visible in the
 * non-archived list, or the message would land hidden.
 *
 * Ownership guard (defense-in-depth): an explicit `threadId` must be a
 * K-OWNED thread (k_threads.profile_id === 'k-secretary'). askK is K's own
 * front door — a caller has no business resolving another profile's
 * conversation through it. A foreign-owned id is treated exactly like a
 * missing one (KThreadNotFoundError / 404) so this never leaks whether the
 * id exists under another profile.
 */
export function resolveAskThread(threadId?: string): KThread {
  if (threadId) {
    const raw = kThreadsDb.getThread.get(threadId) as Row | undefined
    if (!raw || String(raw.profile_id) !== K_SECRETARY_PROFILE_ID) throw new KThreadNotFoundError(threadId)
    const t = rowToKThread(raw)
    if (t.archivedAt == null) return t
    kThreadsDb.setThreadArchived.run(null, Date.now(), t.id)
    return getKThread(t.id)!
  }
  const rows = kThreadsDb.listByProfile.all(K_SECRETARY_PROFILE_ID) as Array<{ id: string; archived_at: number | null }>
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
  const now = Date.now()
  kThreadsDb.insertTurn.run({ id, threadId, role, text, runId, createdAt: now })
  // Visibility invariant (see resolveAskThread): a thread receiving new activity must be visible
  // in the non-archived list. captureAnswers and the message relay's delivery append (B.4 —
  // report-backs now arrive via message-relay.ts, which appends the delivered turn here) both
  // land WITHOUT going through resolveAskThread's un-archive, so centralize it at this choke
  // point — a thread archived mid-run/delegation resurfaces when K's reply lands, instead of the
  // reply landing hidden. Guarded (archived_at IS NOT NULL) so a normal non-archived append is
  // untouched. (resolveAskThread's own explicit un-archive stays, now idempotent with this.)
  kThreadsDb.clearThreadArchivedOnActivity.run(now, threadId)
  return rowToKThreadTurn(kThreadsDb.getTurn.get(id) as Row)
}

// ── seed rendering (cold start) ──────────────────────────────────────────────

/**
 * Render the cold-start seed for a fresh K run: the last {@link SEED_TURN_WINDOW}
 * durable turns as `You:` / `K:` lines, then the current `You: <message>` line, then
 * a short routing instruction. Bounded so the reseed prompt stays small.
 *
 * CALLER CONTRACT (load-bearing for Lane B's stale-path fallback wiring): the caller
 * must have ALREADY persisted the current user turn as the newest durable row (the
 * retired askK did this inline; the session engine's sendToSession does it today).
 * We slice that newest turn OFF the history window (`…, -1`) so the current message
 * appears exactly ONCE — as the explicit trailing line — instead of being doubled
 * (history tail + trailing line). This keeps the "durable before dispatch" guarantee
 * while giving the agent a single crisp ask.
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
 * to its run_id (the session engine's spawn/stdin path patches it on before dispatch), so
 * this only trips for a removed (undone) ask. Deliberately NOT applied to
 * continueLeadOutcomeToK, whose queued message carries the LEAD run as provenance (a lead
 * run never has a user turn) and which is already gated by resolveKDelegationThread —
 * undo deletes the delegating user turn, breaking that link.
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

// ── report-back seams (Lane B.4 reroutes the callers through the mailbox) ─────

/** Max length of BOTH report-back message bodies queued to K's thread — the Chief's
 *  mgmt-report text AND the assistant-text fallback — so a verbose Chief run can't dump
 *  a huge transcript (the mgmt `report` zod max is 20k; both hops share this 2000 cap). */
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

/**
 * INT.2 (B.4 ⇄ C.5 dual-write reconcile, D-124): has this run's report body ALREADY
 * been queued to K as a mailbox message? The mgmt `report` tool (C.5) dual-writes
 * every run-context report to K's mailbox at FILE time (provenance = the reporting
 * run, body = the raw report). Without this check the terminal report-back (B.4)
 * would re-quote the same report — the operator reads the identical content twice
 * in one conversation. Any status counts: at queue time the content entered the
 * mailbox channel; a later delivery failure is that channel's own, non-silent
 * concern (failed row + notification). When the dual-write itself failed (its
 * best-effort catch), no row exists and the terminal re-quote still carries the
 * report — the degradation path keeps the content flowing.
 */
const reportAlreadyMessaged = db.prepare(
  `SELECT 1 AS hit FROM agent_messages
   WHERE provenance_run_id = ? AND from_kind = 'profile' AND body = ? LIMIT 1`,
)

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
 * Summarize a delegated Chief run's outcome for the report-back message. Prefers the
 * Chief's latest mgmt `report` (the status written UP the chain), falling back to the
 * run's own assistant text, then to a bare status line — so the operator always sees
 * *something* land where they asked, even if the Chief filed no formal report.
 */
export function summarizeDelegatedOutcome(childRunId: string, status: string): string {
  const verb = status === 'done' ? 'completed' : status
  const reports = mgmtDb.listReportsByRun.all(childRunId, 1) as Row[]
  let reportBody = reports.length > 0 ? String(reports[0].body) : ''
  // INT.2 de-dup: the C.5 dual-write already delivered this report to K's mailbox
  // in real time — the terminal message must add the OUTCOME, not repeat the body.
  if (reportBody.length > 0 && reportAlreadyMessaged.get(childRunId, reportBody)) reportBody = ''
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
 * Report a delegated Chief run's outcome back UP to K. Rides the shared run-lifecycle
 * seam (trackSupervisedRun) exactly like startAgentRun's own tracking: on the child
 * run's terminal — once, race-backstopped — it QUEUES an agent message from the Chief
 * to K's originating thread (B.4, D-124); the message relay delivers it and the wake
 * path lands the durable turn — no bespoke appendTurn here. It does NOT touch the
 * thread's active_run_id (that belongs to K's own warm session, a separate concern
 * from a delegated run).
 * A.4×B.4 / SEAMS#1-m2 NOTE — PRODUCTION-ORPHANED: the in-context askK
 * auto-delegation path is retired (D-126) and grep confirms NO non-test caller
 * remains. K's real outcome channels are continuePipelineOutcomeToK
 * (delegate_pipeline) and the C.5 mgmt-`report` dual-write. This seam is KEPT,
 * fully wired and test-locked, as the report-back for any future surface that
 * dispatches a bare Chief/agent run against a K thread — do not assume it fires
 * today, and delete it instead of re-wiring around it if that surface never comes.
 */
export function reportDelegationBack(threadId: string, childRunId: string): void {
  trackSupervisedRun(childRunId, {
    onStarted: () => { /* runId already known — nothing to patch */ },
    finalize: status => {
      // Same undo gate as captureAnswers (F-060): if the operator undid this delegation
      // (kill + turn-delete), the Chief run's terminal must not resurrect a report.
      if (kReplySuppressed(childRunId)) return
      // B.4 (D-124): the report-back is a MESSAGE from the Chief to K's originating
      // thread — the relay delivers it (wake path lands the durable turn), no bespoke
      // append. queueMessage can throw (e.g. the thread was deleted mid-run): swallow
      // with a warn — a lifecycle subscriber must never crash the event bus. The body
      // is summarized OUTSIDE the try so the warn label stays triage-accurate.
      const body = summarizeDelegatedOutcome(childRunId, status)
      try {
        queueMessage({
          toProfileId: 'k-secretary',
          toThreadId: threadId,
          from: { kind: 'profile', profileId: 'chief' },
          body,
          provenanceRunId: childRunId,
        })
      } catch (e) {
        console.warn(`[k-thread] delegation report-back for ${childRunId} failed to queue:`, e)
      }
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
 * derivable with NO new table: the delegating ask's user turn carries the run id
 * (askK's session spawn — and, historically, the retired delegateToChief — patches it
 * on), so a k_thread_turns row whose run_id = chiefRunId identifies the delegating
 * thread. Null ⇒ the Chief run was NOT a K delegation (it woke autonomously via
 * chief-wake, which never touches k_thread_turns) — so there is nothing to continue up.
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
  let reportBody = reports.length > 0 ? String(reports[0].body) : ''
  // INT.2 de-dup (same as summarizeDelegatedOutcome): a C.5-dual-written report is
  // already in K's mailbox — fall through to the conclusion/status line instead.
  if (reportBody.length > 0 && reportAlreadyMessaged.get(leadRunId, reportBody)) reportBody = ''
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
 * Continue a dispatched lead's outcome UP to K (the final hop of the up-chain). Rides
 * the shared run-lifecycle seam on the LEAD run: on the lead's terminal — once,
 * race-backstopped — IF the parent Chief run was itself a K delegation (a k_thread_turn
 * links it to a thread), it QUEUES an agent message summarizing the lead's outcome (B.4)
 * from the REPORTING profile — the lead that ran the work — with the lead run as
 * provenance; the relay delivers it. If the Chief woke autonomously (no linked thread)
 * it is a no-op — the lead outcome stays in the Chief's mgmt store only. Deliberately
 * independent of reportLeadOutcomeToChief (each rides its own once-latched subscriber
 * on the same lead terminal), mirroring reportDelegationBack's shape.
 */
export function continueLeadOutcomeToK(chiefRunId: string, leadRunId: string, lead: string): void {
  trackSupervisedRun(leadRunId, {
    onStarted: () => { /* runId already known — nothing to patch */ },
    finalize: status => {
      const threadId = resolveKDelegationThread(chiefRunId)
      if (threadId == null) return // Chief woke autonomously — nothing to continue up.
      // B.4: the continuation is a MESSAGE from the REPORTING profile — the lead that
      // ran the work (resolved from its activation), falling back to 'chief' (the
      // chain's owner) when the lead run has no agent_runs row.
      const prof = agentRunsDb.getAgentRunProfileByRunId.get(leadRunId) as
        | { profile_id?: string }
        | undefined
      const body = summarizeChiefLeadContinuation(leadRunId, lead, status)
      try {
        queueMessage({
          toProfileId: 'k-secretary',
          toThreadId: threadId,
          from: { kind: 'profile', profileId: prof?.profile_id != null ? String(prof.profile_id) : 'chief' },
          body,
          provenanceRunId: leadRunId,
        })
      } catch (e) {
        console.warn(`[k-thread] lead continuation for ${leadRunId} failed to queue:`, e)
      }
    },
  })
}

// ── pipeline→K continuation (C1 — complete the up-chain for a delegated pipeline) ─
//
// A K/Chief-delegated pipeline (delegate_pipeline → pipeline-dispatch-relay) is MULTI-run: there
// is no single supervised run to ride the way continueLeadOutcomeToK rides the lead run. So this
// hooks the ENGINE's terminal seam (pipeline-engine.ts::onPipelineTerminal, fired once when a
// pipeline reaches completed/failed) and continues the outcome UP onto K's durable thread when the
// pipeline was linked to a `pipeline_dispatches` row carrying a k_run_id.

/** Resolve the k_run_id that delegated a given pipeline run, or null. setPipelineDispatchRun stamps
 *  pipeline_run_id onto exactly the one intent that started it, so a lookup by that id is unique;
 *  a NULL k_run_id (or no row) ⇒ the pipeline was not a K/Chief delegation (an operator HTTP run or
 *  an ad-hoc start), so there is nothing to continue up. Local prepared statement (the engine's
 *  backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen. */
const getDelegatingKRunForPipeline = db.prepare(
  `SELECT k_run_id FROM pipeline_dispatches WHERE pipeline_run_id = ? AND k_run_id IS NOT NULL`,
)

/** A concise terminal-outcome line for a delegated pipeline, framed by its title. Pure + exported
 *  so a test can assert the phrasing. */
export function summarizePipelineOutcome(pipelineRunId: string, status: 'completed' | 'failed'): string {
  const run = pipelineDb.getPipelineRun.get(pipelineRunId) as { title?: string } | undefined
  const label = run?.title ? `"${String(run.title)}"` : `pipeline ${pipelineRunId}`
  return `Pipeline ${label} ${status}.`
}

/**
 * Register the pipeline→K continuation as a GLOBAL engine terminal listener (wired once at boot).
 * On EACH pipeline terminal: if the pipeline was linked to a delegation intent with a k_run_id AND
 * that K/Chief run was itself a K-thread delegation (a k_thread_turn links it — the SAME derivation
 * continueLeadOutcomeToK uses), QUEUE a concise outcome message (B.4) from the pipeline's owning
 * orchestrator profile onto the delegating thread; the relay delivers it. A pipeline that was NOT
 * a K delegation, or whose owner woke autonomously, is a no-op. Returns the unregister fn (mirrors
 * startLeadDispatchRelay's stop-fn shape) so boot can tear it down.
 */
export function continuePipelineOutcomeToK(): () => void {
  return onPipelineTerminal((pipelineRunId, status) => {
    const row = getDelegatingKRunForPipeline.get(pipelineRunId) as { k_run_id?: string } | undefined
    if (!row?.k_run_id) return // not a K/Chief-delegated pipeline — nothing to continue up.
    const threadId = resolveKDelegationThread(String(row.k_run_id))
    if (threadId == null) return // the owning K/Chief run was not a K-thread delegation.
    // B.4: a MESSAGE from the pipeline's owning orchestrator profile (the closest
    // "reporting profile" a multi-run pipeline has), falling back to the delegating
    // run's profile, then K itself. provenance NULL — no single run owns the outcome.
    const pr = pipelineDb.getPipelineRun.get(pipelineRunId) as
      | { owner_profile_id?: string | null; definition_id?: string | null }
      | undefined
    const kProf = agentRunsDb.getAgentRunProfileByRunId.get(String(row.k_run_id)) as
      | { profile_id?: string }
      | undefined
    let fromProfileId =
      pr?.owner_profile_id != null
        ? String(pr.owner_profile_id)
        : kProf?.profile_id != null
          ? String(kProf.profile_id)
          : K_SECRETARY_PROFILE_ID
    // The generic seeded default-orchestrator (profiles.ts:208, id ORG_DEFAULT_PROFILE_ID)
    // is a catch-all row, not a real orchestrator/manager identity an operator recognizes
    // — authoring an outcome note into ITS OWN conversation is the stray "orchestrator"
    // message bug (an unowned conversation surfacing in Messages). Redirect to the
    // pipeline definition's DOMAIN MANAGER instead — the SAME resolution
    // routes/pipelines.ts's "Observed by" default uses (domainForPipelineDef(defId)
    // ?.managerProfileId) — when one resolves to a real, non-deleted profile; otherwise
    // fall through to the deleted-owner guard below, which lands k-secretary delivery on
    // the delegating thread. The generic profile's own conversation is NEVER addressed.
    if (fromProfileId === ORG_DEFAULT_PROFILE_ID) {
      const managerId =
        pr?.definition_id != null ? domainForPipelineDef(String(pr.definition_id))?.managerProfileId ?? null : null
      fromProfileId = managerId != null && getProfile(managerId) ? managerId : K_SECRETARY_PROFILE_ID
    }
    // owner_profile_id has no FK (a profile can be deleted without invalidating run
    // history), so a since-deleted owner would make queueMessage throw "unknown target
    // profile" and the outcome would silently vanish. Fall back to k-secretary delivery
    // so a completed pipeline's report-back is never lost.
    if (fromProfileId !== K_SECRETARY_PROFILE_ID && !getProfile(fromProfileId)) {
      fromProfileId = K_SECRETARY_PROFILE_ID
    }
    const body = summarizePipelineOutcome(pipelineRunId, status)
    // Deliver to the RESOLVED OWNER's own conversation, not unconditionally to
    // k-secretary's thread (the "random orchestrator in K's chat" bug): when the
    // pipeline's owner is a real orchestrator/manager profile, its outcome belongs
    // in THAT profile's own conversation (getOrCreateConversation — same
    // self-addressed-delivery pattern domain-supervisor.ts::briefDomain uses), so
    // K's personal chat never surfaces another profile's pipeline updates. Only the
    // k-secretary-owned case (no resolvable owner, or K itself delegated it) keeps
    // landing on the original delegating thread. Both toProfileId/toThreadId move
    // together — queueMessage requires toThreadId's owning profile_id === toProfileId.
    const toThreadId = fromProfileId === K_SECRETARY_PROFILE_ID ? threadId : getOrCreateConversation(fromProfileId).id
    try {
      queueMessage({
        toProfileId: fromProfileId,
        toThreadId,
        from: { kind: 'profile', profileId: fromProfileId },
        body,
        provenanceRunId: null,
      })
    } catch (e) {
      console.warn(`[k-thread] pipeline continuation for ${pipelineRunId} failed to queue:`, e)
    }
  })
}

// ── the front door ───────────────────────────────────────────────────────────

/** FORCED-route target → the profile whose MAILBOX receives the message (D-126).
 *  Total over KForceRoute by construction: the Chief + the five discipline leads.
 *  Exported so a test can pin the totality against KForceRouteSchema. */
export const FORCE_ROUTE_PROFILE: Record<KForceRoute, string> = {
  chief: 'chief',
  frontend: 'lead-frontend',
  backend: 'lead-backend',
  systems: 'lead-systems',
  security: 'lead-security',
  network: 'lead-network',
}

/** The agent_runs tracking id for a session-engine run (KAskResult.agentRunId).
 *  Local prepared statement (the frozen-db-bundle precedent); newest row wins if
 *  a run id were ever re-tracked. */
const getAgentRunIdByRunId = db.prepare(
  `SELECT id FROM agent_runs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
)

/**
 * Activate K for one message (D-023 → D-126). askK rides the SESSION ENGINE: it
 * resolves the target thread, then hands the message to K's (k-secretary, thread)
 * session via {@link sendToSession} — a live parked run receives it over stdin
 * (`warm: true`, same run), else an interactive session run is spawned (the
 * establish/resume decision keys off the session row's cli_session_id). The
 * durable user turn is appended BY sendToSession (the thread stays the source of
 * truth; askK must not double-append). K decides in context — the deterministic
 * router survives only as the returned display PREVIEW (`route`), never as a
 * delegation decision.
 *
 * FORCED route (D-126): `opts.forceRoute` is an explicit operator message TO that
 * agent — it is QUEUED to the target profile's mailbox (agent_messages; Lane B's
 * relay delivers, rows sit 'queued' until then), with a durable user turn + a `k`
 * ack turn on the thread. Nothing is dispatched: the result carries
 * `runId: null, agentRunId: null, messageId` (no undo affordance). A mailbox
 * write is free, so a forced route works even while the org budget is capped
 * (routes/k.ts's 429 mapping survives as a dead-belt only).
 *
 * `opts.model` is an explicit per-ask model override threaded to the session
 * dispatch (spawn path; a warm stdin delivery continues under the live run's
 * model).
 *
 * Multi-thread (UI Simplification): `opts.threadId` targets a specific thread via
 * {@link resolveAskThread} — an explicit unknown id throws {@link KThreadNotFoundError}
 * (the route layer 404s, BEFORE any turn is appended); omitted, it resolves to the
 * most-recent non-archived thread as before. A thread's still-untitled first ask
 * stamps its title from the message so a freshly created thread shows something
 * in a thread list without a separate rename step.
 */
export async function askK(
  message: string,
  opts: { forceRoute?: KForceRoute; model?: string; threadId?: string } = {},
): Promise<KAskResult> {
  const thread = resolveAskThread(opts.threadId)
  // The route PREVIEW — routeForTarget/routeForMessage are the SAME shared
  // mappings the composer previews, so client and server render identically.
  const route = opts.forceRoute ? routeForTarget(opts.forceRoute) : routeForMessage(message)
  // Title-on-first-send: guarded on title == null, so it only ever fires once.
  if (thread.title == null) kThreadsDb.setThreadTitle.run(message.slice(0, 60), Date.now(), thread.id)

  if (opts.forceRoute) {
    // D-126: K decides in-context; a FORCED route is now an explicit operator
    // message to that agent — queued to the mailbox (Lane B's relay delivers at
    // INT; until then the row sits 'queued'). The durable user turn + ack land on
    // the thread so the operator sees what was queued and where.
    appendTurn(thread.id, 'user', message, null)
    const messageId = randomUUID()
    agentMessagesDb.insert.run({
      id: messageId,
      toProfileId: FORCE_ROUTE_PROFILE[opts.forceRoute],
      toThreadId: null,
      fromKind: 'user',
      fromProfileId: null,
      body: message,
      priority: 'normal',
      provenanceRunId: null,
      createdAt: Date.now(),
    })
    appendTurn(thread.id, 'k', `Queued for ${route.label}: "${message}"`, null)
    return { kThreadId: thread.id, agentRunId: null, runId: null, route, warm: false, messageId }
  }

  // The session engine owns delivery (durable turn, live-stdin vs interactive
  // spawn, establish/resume, captureAnswers wiring). Chat turns are budget- and
  // plan-gate-exempt by KIND (A.3), so no BudgetCapError handling lives here.
  const session = ensureSession('k-secretary', thread.id)
  const res = await sendToSession(session.id, message, { from: { kind: 'user' }, model: opts.model })
  const agentRunId = (getAgentRunIdByRunId.get(res.runId) as { id?: string } | undefined)?.id ?? null
  return { kThreadId: thread.id, agentRunId, runId: res.runId, route, warm: res.mode === 'stdin' }
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
 * A.4 (D-126): the LIVE session taint moved to {@link undoSessionRun} — K's CLI
 * continuity lives on the agent_sessions row now, and the run's terminal finalize
 * consumes the taint there. The k_threads.cli_session_id clear below is the
 * RETIRED W7a design's belt, kept as harmless double-safety (the column no longer
 * drives dispatch). The rest of this doc describes that legacy path.
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
  // A.4: scrub the SESSION-ENGINE side BEFORE the kill so its taint + attachment
  // teardown are in place before any terminal can land — the run is tainted (its
  // terminal finalize writes nothing), a live attachment is detached (no follow-up
  // send can ride stdin into the dying run), and the owning agent_sessions row is
  // scrubbed (cli_session_id NULL + 'stale') so the next send re-establishes from
  // the cleaned durable turns. The legacy k_threads clears below stay as harmless
  // double-safety. NB (flagged for INT/UX review): a session run can be MULTI-TURN
  // now — the turn-delete below removes EVERY turn linked to the run id, so undoing
  // a long-lived live run scrubs all of its turns, not only the latest exchange.
  undoSessionRun(runId)
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
