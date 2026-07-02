/**
 * K front-door runtime (D-023) — persistent identity (the durable thread is the
 * SOURCE OF TRUTH), ephemeral execution (a warm interactive run while chatting,
 * fresh-seeded from the thread when cold). Reuses the D-014 persistent-stdin
 * machinery via startAgentRun(interactive) + supervisor.sendInput.
 *
 * SDK-free, like mcp/logistics.ts: no Fastify/transport import, so it is unit-
 * testable directly against the DB + EventBus. The route layer (routes/k.ts) is a
 * thin adapter over askK / ensureDefaultKThread / listKThreadTurns.
 */
import { randomUUID } from 'crypto'
import type { KThread, KThreadTurn, KAskResult, KRoute } from '@k/shared'
import { routeForMessage } from '@k/shared'
import { kThreadsDb, runsDb, eventsDb, mgmtDb } from './db.js'
import { eventBus } from './events.js'
import { startAgentRun } from './agent-runs.js'
import { sendInput } from './supervisor.js'
import { isTerminalRunStatus, trackSupervisedRun } from './run-lifecycle.js'

/** The singleton default K thread — the one front-door conversation for now. */
export const DEFAULT_K_THREAD_ID = 'k-default'

/** How many recent turns to fold into a cold reseed (bounded so the prompt stays small). */
const SEED_TURN_WINDOW = 12

/** The routing/behavior instruction appended to a cold reseed. */
const K_SEED_INSTRUCTION =
  '(You are K, the secretary front door. Handle logistics/Q&A/scheduling/notes/tasks yourself; ' +
  'otherwise route engineering to the Chief or a named lead, stating the route first.)'

// ── row → type mappers (snake_case → camelCase) ──────────────────────────────

type Row = Record<string, unknown>

function rowToKThread(r: Row): KThread {
  return {
    id: String(r.id),
    title: r.title == null ? null : String(r.title),
    status: r.status as KThread['status'],
    activeRunId: r.active_run_id == null ? null : String(r.active_run_id),
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

// ── warmth ───────────────────────────────────────────────────────────────────

/** True iff the thread has a live interactive run parked at awaiting_input — i.e.
 *  the next message can continue the warm session instead of starting fresh. */
export function isWarm(thread: KThread): boolean {
  if (thread.activeRunId == null) return false
  const r = runsDb.getRun.get(thread.activeRunId) as { status?: string } | undefined
  return r?.status === 'awaiting_input'
}

// ── answer capture (K's replies → durable thread) ────────────────────────────

/**
 * Subscribe to run updates for `runId` and capture K's answers back onto the thread
 * at each turn boundary, so a later cold reseed stays coherent (K remembers its own
 * replies, not just the user's asks). On each update for this run that is awaiting
 * input OR terminal, read the run's `assistant` events with seq > lastSeq, concat
 * their text, and append a `k` turn if non-empty; advance lastSeq. On a terminal
 * status, unsubscribe FIRST then clear the thread's active run (status → idle),
 * once — mirroring run-lifecycle's unsub-before-write + once-latch discipline so a
 * duplicate terminal event can't double-clear.
 */
export function captureAnswers(threadId: string, runId: string): void {
  let lastSeq = 0
  let done = false

  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== runId) return
    const terminal = isTerminalRunStatus(r.status)

    if (r.status === 'awaiting_input' || terminal) {
      const rows = eventsDb.listEvents.all(runId) as Row[]
      let maxSeq = lastSeq
      const parts: string[] = []
      for (const row of rows) {
        const seq = Number(row.seq)
        if (seq <= lastSeq) continue
        if (seq > maxSeq) maxSeq = seq
        if (row.type === 'assistant') {
          const text = row.text == null ? '' : String(row.text)
          if (text.length > 0) parts.push(text)
        }
      }
      lastSeq = maxSeq
      const concat = parts.join('\n')
      if (concat.length > 0) appendTurn(threadId, 'k', concat, runId)
    }

    if (terminal) {
      if (done) return // once-latch: a duplicate terminal can't double-clear
      done = true
      // Unsub BEFORE the write so a duplicate terminal delivered in the same tick
      // can't re-enter and clear twice.
      unsub()
      const now = Date.now()
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
  const hint =
    route.target === 'chief'
      ? ''
      : ` The operator's request points at the ${route.target} discipline` +
        ` (route preview: ${route.label}); assign the appropriate lead if it fits.`
  return (
    `Delegated from K (the secretary) on the operator's behalf: "${message}".${hint}` +
    ' Break it down, assign the right lead, and file a concise status report up the chain.'
  )
}

/** Max length of the assistant-text report-back FALLBACK, so a verbose Chief run
 *  can't dump a huge raw transcript onto K's thread (the preferred mgmt-report path
 *  is already bounded by its own zod max). */
const REPORT_BACK_TEXT_CAP = 2_000

/** Concatenate a run's `assistant` event texts (oldest→newest), capped — the delegated
 *  run's own final answer, the report-back fallback when the Chief filed no mgmt
 *  report. Capped rather than windowed like captureAnswers: this is a one-shot summary,
 *  not a stateful turn-by-turn capture. */
function concatAssistantText(runId: string): string {
  const rows = eventsDb.listEvents.all(runId) as Row[]
  const parts: string[] = []
  for (const row of rows) {
    if (row.type !== 'assistant') continue
    const text = row.text == null ? '' : String(row.text)
    if (text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n')
  return joined.length > REPORT_BACK_TEXT_CAP ? `${joined.slice(0, REPORT_BACK_TEXT_CAP)}…` : joined
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
  if (reportBody.length > 0) return `Chief (delegation ${verb}) reported: ${reportBody}`
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
 * thread. Prefers the lead run's own assistant text (reusing this module's capped
 * concatAssistantText — the same source reportDelegationBack falls back to); a bare status
 * line when the lead produced no summary. Pure + exported so a test can assert the phrasing.
 */
export function summarizeChiefLeadContinuation(leadRunId: string, lead: string, status: string): string {
  const verb = status === 'done' ? 'completed' : status
  const answer = concatAssistantText(leadRunId)
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
): Promise<KAskResult> {
  const goal = buildDelegationGoal(message, route)
  // Deliberate: an operator-initiated delegation dispatches the Chief DIRECTLY, NOT via
  // chief-wake's wakeChief — so it is intentionally NOT subject to the autonomous-wake
  // debounce (Guard A) or the one-at-a-time already-running guard (Guard B). Those guards
  // exist to keep the AUTONOMOUS loop bounded; silently dropping or debouncing an explicit
  // human ask would be worse. mgmt rows are per-run_id scoped, so a concurrent chief run
  // can't corrupt another's store; the self-wake guard still stops this run's terminal from
  // re-waking the Chief (its agent_runs.profile_id === 'chief').
  const { agentRunId, runId } = await startAgentRun('chief', { trigger: 'delegation', goal })
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
 * otherwise K handles it itself — CONTINUING the warm interactive run (feed the turn
 * via sendInput) or starting a FRESH interactive run seeded from the thread. Returns
 * the thread id, the run id, the deterministic route PREVIEW, and whether it was warm.
 */
export async function askK(message: string): Promise<KAskResult> {
  const thread = ensureDefaultKThread()
  const route = routeForMessage(message)

  // The durable ask — recorded up front so it survives even if the dispatch below
  // throws (startAgentRun rolls back only its own agent_runs row; the ask stays,
  // which is acceptable: the thread is the source of truth for what was asked).
  const turn = appendTurn(thread.id, 'user', message, null)

  // Delegation path (D-046): an engineering-routed ask (Chief or a named lead) hands
  // UP to the Chief instead of K running it. Checked BEFORE warm/cold — a hand-up is
  // independent of K's own conversational state — so logistics/Q&A keeps the exact
  // warm/fresh K path below, unchanged.
  if (route.escalates) {
    return delegateToChief(thread, message, route, turn)
  }

  // Warm path: continue the live interactive run.
  if (isWarm(thread)) {
    const activeRunId = thread.activeRunId!
    if (sendInput(activeRunId, message)) {
      kThreadsDb.patchTurnRunId.run(activeRunId, turn.id)
      return { kThreadId: thread.id, agentRunId: null, runId: activeRunId, route, warm: true }
    }
    // sendInput returned false — the warm run died in the window; fall through to fresh.
  }

  // Cold path: start a fresh interactive run, seeded from the durable thread.
  const { agentRunId, runId } = await startAgentRun('k-secretary', {
    trigger: 'user-message',
    thread: renderSeed(thread.id, message),
    interactive: true,
  })
  kThreadsDb.updateThreadActiveRun.run(runId, Date.now(), thread.id)
  kThreadsDb.patchTurnRunId.run(runId, turn.id)
  captureAnswers(thread.id, runId)
  return { kThreadId: thread.id, agentRunId, runId, route, warm: false }
}
