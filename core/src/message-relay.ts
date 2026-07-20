/**
 * message-relay.ts — the MAIN-process drain for the agent mailbox (Continuous
 * Agents B.2, D-124). lead-dispatch-relay-shaped: an exported, directly-testable
 * drain body + a start/stop wiring fn with an env opt-out and an unref'd interval.
 *
 * Delivery policy (the store deliberately has none — B.1):
 *  - Messages are grouped per conversation (to_profile_id + resolved thread) and
 *    delivered in created_at order. Priority selects the delivery CELL
 *    (resolveDelivery), not the batch order.
 *  - live + parked  → supervisor.sendInput of a provenance-tagged block into the
 *    parked run; the relay appends the matching durable `user` turn itself (stdin
 *    bypasses sendToSession's append). sendInput returning false (raced un-park /
 *    dead pipe) REVERTS the claims to 'queued' — boundary retry, never a false
 *    'delivered' and never 'failed' (nothing is wrong with the message).
 *  - live + mid-turn → leave queued this tick ('boundary'; the 'interrupt' cell is
 *    EXECUTED as boundary until INT.4). A later tick finds the run parked or the
 *    session demoted and delivers.
 *  - idle (resumable/stale) → ONE sendToSession wake batching ALL of the
 *    conversation's queued messages. The tagged block IS the provenance
 *    (relay-owned; the W0 interim `[from x]` turn tag is RETIRED — SEAMS#2 m2).
 *    A batch containing any profile-authored row passes a profile `from` so the
 *    wake is BUDGET-GATED as agent-caused spend (SEAMS#2 b) and damped by the
 *    rolling-hour circuit-breaker; budget-capped/breaker-held batches stay
 *    QUEUED (reverted claims), never 'failed'.
 *  - W0 in-flight guard: a thread whose active_run_id points at a NON-terminal run
 *    is treated as mid-turn even when the session row is not 'live' — the W0
 *    adapter's one-shot turns never mark the session live, and waking mid-turn
 *    would trip the documented concurrent-send double-establish hazard.
 *  - Failure AFTER claiming → the claimed set flips to 'failed' (delivered_at
 *    cleared) + one 'message_failed' notification row — never silent, and a bad
 *    conversation never crashes the drain loop.
 *
 * Concurrency: single main process (instance lock) + a module-level `draining`
 * latch (overlapping ticks no-op) + per-row CAS claims (queued→delivered), so a
 * message is delivered EXACTLY ONCE in a live process — and AT-MOST-ONCE across a
 * crash: the claim lands before the send, so a process death inside the send
 * window (the whole `await sendToSession` on the wake path; a sync sliver on the
 * stdin path) can leave rows 'delivered'-but-never-sent, with no recorded
 * post-send fact a boot sweep could use to tell them apart (contrast
 * lead_dispatches' lead_run_id + reconcileOrphanedLeadDispatches). Accepted for a
 * steering mailbox; the wake path additionally self-heals in practice because the
 * durable turn (sendToSession appends it pre-dispatch) re-enters a later
 * establishing seed. An exactly-once upgrade (intermediate 'delivering' status +
 * boot sweep) is an INT-stage option if ever required.
 */
import { randomUUID } from 'crypto'
import type { AgentMessage, Notification } from '@k/shared'
import { db, agentMessagesDb, kThreadsDb, runsDb, notificationsDb } from './db.js'
import { eventBus } from './events.js'
import { ensureSession, getOrCreateConversation, sendToSession } from './agent-sessions.js'
import { resolveDelivery, rowToAgentMessage } from './agent-mail.js'
import { sendInput, sendInterrupt } from './supervisor.js'
import { appendTurn } from './k-thread.js'
import { isTerminalRunStatus } from './run-lifecycle.js'
import { BudgetCapError } from './budget-governor.js'

const DEFAULT_RELAY_INTERVAL_MS = 2_000

/** INT.4: how long after one interrupt nudge before the relay re-nudges the same
 *  run (the CLI may legitimately take a while to reach its abort point). */
const INTERRUPT_RESEND_MS = 30_000

/** runId → when the relay last wrote a control_request interrupt for it. Bounded:
 *  entries are deleted at the run's successful boundary delivery, and a run id is
 *  never reused — residue is one timestamp per interrupted-but-never-delivered
 *  run in this process (the sendChains boundedness posture). */
const interruptRequestedAt = new Map<string, number>()

// ── SEAMS#2 (b): profile-originated wake bounds ──────────────────────────────
// The budget gate (agent-runs.ts) is the FINANCIAL bound on agent-caused wakes;
// this circuit-breaker is the LOOP damper on top: a tier-permitted message
// ping-pong (manager↔orchestrator, K↔anyone) is throttled to a rolling-hour wake
// budget even while the org is under its cap. In-memory (restart resets — a
// damper, not the meter); env-tunable; 0 disables the breaker entirely.
const DEFAULT_PROFILE_WAKES_PER_HOUR = 30
function profileWakesPerHour(): number {
  const n = Number(process.env.MESSAGE_RELAY_PROFILE_WAKES_PER_HOUR)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROFILE_WAKES_PER_HOUR
}
const profileWakeTimes: number[] = []
let breakerNotifiedAt = 0
let budgetNotifiedAt = 0
const HOLD_NOTIFY_MIN_INTERVAL_MS = 60 * 60 * 1000

/** Prune + count profile-originated wakes in the trailing hour. */
function recentProfileWakes(now: number): number {
  while (profileWakeTimes.length > 0 && profileWakeTimes[0] <= now - 3_600_000) profileWakeTimes.shift()
  return profileWakeTimes.length
}

/** One un-spammy notification for a HOLD condition (breaker/budget): the rows
 *  stay queued (retried every tick), so notify at most once per hour. */
function notifyHoldOnce(kind: 'breaker' | 'budget', body: string): void {
  const now = Date.now()
  if (kind === 'breaker') {
    if (now - breakerNotifiedAt < HOLD_NOTIFY_MIN_INTERVAL_MS) return
    breakerNotifiedAt = now
  } else {
    if (now - budgetNotifiedAt < HOLD_NOTIFY_MIN_INTERVAL_MS) return
    budgetNotifiedAt = now
  }
  try {
    const n: Notification = {
      id: randomUUID(), eventKey: 'message_failed',
      title: kind === 'breaker' ? 'Agent messages held — wake circuit-breaker' : 'Agent messages held — org budget cap',
      body: body.slice(0, 500), runId: null, projectId: null, createdAt: now, readAt: null,
    }
    notificationsDb.insertNotification.run({
      id: n.id, eventKey: n.eventKey, title: n.title, body: n.body,
      runId: null, projectId: null, createdAt: n.createdAt, readAt: null,
    })
    eventBus.broadcast({ type: 'notification', notification: n, browser: false })
  } catch { /* never let the notifier crash the drain */ }
}

/** Test-only seam (the supervisor __testHooks precedent — keep usage confined to
 *  core/test/*): reset the in-memory profile-wake breaker + hold-notify throttles
 *  so tests don't inherit earlier files'/tests' wake history. */
export const __relayTestHooks = {
  resetProfileWakeBreaker(): void {
    profileWakeTimes.length = 0
    breakerNotifiedAt = 0
    budgetNotifiedAt = 0
  },
}

let draining = false

const listAllQueued = db.prepare(
  `SELECT * FROM agent_messages WHERE status = 'queued' ORDER BY created_at ASC, id ASC`,
)
const claimQueued = db.prepare(
  `UPDATE agent_messages SET status = 'delivered', delivered_at = @deliveredAt
   WHERE id = @id AND status = 'queued'`,
)
const revertClaim = db.prepare(
  `UPDATE agent_messages SET status = 'queued', delivered_at = NULL
   WHERE id = @id AND status = 'delivered'`,
)
// Unlike the W0 markFailed (status only), a claimed-then-failed row must not keep a
// delivered_at it never earned.
const failClaimed = db.prepare(
  `UPDATE agent_messages SET status = 'failed', delivered_at = NULL WHERE id = @id`,
)

/**
 * Neutralize provenance-tag lookalikes INSIDE a message body (INT.2, SEAMS-carried
 * forge vector): the UI splits batched turns at line-leading `[message from …]` /
 * `[from …]` boundaries and attributes each segment to its tag's sender — so a body
 * containing its own line-leading tag would FORGE a segment from an arbitrary
 * sender. Only line-leading positions can forge (both UI regexes anchor at turn
 * start or after a blank line), so escape exactly those with a backslash; the UI
 * unescapes for display (ConversationView), keeping the rendered text identical.
 * Residual (documented, accepted): a body deliberately containing the ESCAPED form
 * `\[message from …]` renders unescaped. Exported for tests.
 */
export function escapeProvenanceLookalikes(body: string): string {
  return body.replace(/(^|\n)(\[(?:message )?from )/g, '$1\\$2')
}

/** The relay's provenance tag — the REAL provenance block (supersedes W0's interim
 *  `[from x]` turn tag). Exported for tests + the UI's parse contract. The BODY is
 *  escaped against tag forgery (escapeProvenanceLookalikes); the mailbox row keeps
 *  the verbatim body — escaping is a transcript-embedding concern only. */
export function provenanceBlock(m: AgentMessage): string {
  const sender = m.fromKind === 'user' ? 'user' : (m.fromProfileId ?? 'unknown')
  return `[message from ${sender} · ${m.priority}] ${escapeProvenanceLookalikes(m.body)}`
}

/** One 'message_failed' notification row + WS broadcast (best-effort — the failed
 *  status on the rows is the durable record). DELIBERATELY bypasses the E-19 rules
 *  gate (notify.ts::ruleFor): "failure → a notifications row, never silent" is a
 *  plan-level requirement (B.2), so a relay delivery failure must not be
 *  silenceable by an operator rule toggle. Consistent with leaving the
 *  'message_failed' key unseeded in notification_rules — no Settings toggle row
 *  renders for it, and none is intended. */
function notifyDeliveryFailure(profileId: string, count: number, err: unknown): void {
  try {
    const n: Notification = {
      id: randomUUID(),
      eventKey: 'message_failed',
      title: 'Agent message delivery failed',
      body: `${count} message(s) to ${profileId}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      runId: null,
      projectId: null,
      createdAt: Date.now(),
      readAt: null,
    }
    notificationsDb.insertNotification.run({
      id: n.id, eventKey: n.eventKey, title: n.title, body: n.body,
      runId: null, projectId: null, createdAt: n.createdAt, readAt: null,
    })
    eventBus.broadcast({ type: 'notification', notification: n, browser: false })
  } catch { /* never let the notifier crash the drain */ }
}

interface ConversationGroup {
  profileId: string
  threadId: string
  messages: AgentMessage[]
}

/** Deliver one conversation's queued batch. Returns how many messages were delivered. */
async function deliverConversation(g: ConversationGroup): Promise<number> {
  const claimed: AgentMessage[] = []
  try {
    const session = ensureSession(g.profileId, g.threadId)
    const thread = kThreadsDb.getThread.get(g.threadId) as Record<string, unknown> | undefined
    const activeRunId = thread?.active_run_id == null ? null : String(thread.active_run_id)
    const activeStatus = activeRunId
      ? (runsDb.getRun.get(activeRunId) as { status?: string } | undefined)?.status
      : undefined
    // MISSING runs row (activeStatus undefined) counts as terminal — mirrors the
    // boot sweep's own judgment (supervisor.ts::reconcileStaleKThreads clears such
    // pointers): a deleted run has no live process to double-establish against, so
    // holding on it would strand the conversation until the next boot for nothing.
    const activeNonTerminal =
      activeRunId != null && activeStatus !== undefined && !isTerminalRunStatus(activeStatus)

    if (session.state === 'live') {
      const midTurn = activeStatus !== 'awaiting_input'
      // INT.4 — the 'interrupt' cell is WIRED: an urgent message for a mid-turn
      // run writes one control-protocol interrupt (supervisor.sendInterrupt) so
      // the CLI aborts its turn early. The rows STAY QUEUED either way — the
      // (accelerated or natural) boundary parks the run and the next tick's
      // 'stdin-now' cell delivers. Degradation is built into sendInterrupt: a CLI
      // that ignores control_request simply reaches its natural boundary — the
      // pre-spike fallback behavior, unchanged. One nudge per run per
      // INTERRUPT_RESEND_MS (the abort can legitimately take a while).
      if (midTurn && activeRunId != null &&
          g.messages.some(m => resolveDelivery({ state: 'live', midTurn }, m) === 'interrupt')) {
        const last = interruptRequestedAt.get(activeRunId) ?? 0
        const now = Date.now()
        if (now - last >= INTERRUPT_RESEND_MS && sendInterrupt(activeRunId)) {
          interruptRequestedAt.set(activeRunId, now)
        }
      }
      const deliverable = g.messages.filter(
        m => resolveDelivery({ state: 'live', midTurn }, m) === 'stdin-now',
      )
      // 'boundary' + (post-nudge) 'interrupt' cells: leave queued this tick.
      if (deliverable.length === 0 || activeRunId == null) return 0
      const now = Date.now()
      for (const m of deliverable) {
        if (claimQueued.run({ id: m.id, deliveredAt: now }).changes > 0) claimed.push(m)
      }
      if (claimed.length === 0) return 0
      const block = claimed.map(provenanceBlock).join('\n\n')
      if (!sendInput(activeRunId, block)) {
        // Raced un-park / dead pipe: put the claims back — boundary retry next tick.
        for (const m of claimed) revertClaim.run({ id: m.id })
        claimed.length = 0
        return 0
      }
      // The boundary arrived and delivered — any interrupt-nudge bookkeeping for
      // this run is spent (map boundedness, see interruptRequestedAt).
      interruptRequestedAt.delete(activeRunId)
      // stdin bypasses sendToSession's durable append — the relay owns it here.
      // ISOLATED (the lead-relay post-dispatch-wiring posture): once sendInput
      // returned true the text is IN the live run — a bookkeeping throw here
      // (FK/SQLITE_BUSY) must not fall through to the catch and mislabel a
      // DELIVERED batch as 'failed' (false failure + a re-queue would double-send).
      try {
        appendTurn(g.threadId, 'user', block, activeRunId)
      } catch (turnErr) {
        console.warn(
          `[message-relay] delivered to ${activeRunId} but the durable turn append failed:`,
          turnErr,
        )
      }
      return claimed.length
    }

    // Idle session — but a W0 one-shot turn may still be in flight on the thread:
    // waking now would double-establish (the documented W0 concurrent-send hazard).
    // Hold; the turn's terminal clears active_run_id (a DELETED run doesn't hold —
    // see activeNonTerminal above) and the next tick wakes.
    if (activeNonTerminal) return 0

    // SEAMS#2 (b): a batch containing ANY profile-authored message is an
    // AGENT-CAUSED wake — budget-gated downstream and damped here by the
    // rolling-hour circuit-breaker. Held batches stay queued (retried each
    // tick), with one un-spammy notification per hour.
    const profileSender = g.messages.find(m => m.fromKind === 'profile')
    const now = Date.now()
    if (profileSender) {
      const cap = profileWakesPerHour()
      if (cap > 0 && recentProfileWakes(now) >= cap) {
        notifyHoldOnce('breaker',
          `profile-originated wakes hit the rolling-hour breaker (${cap}/h; MESSAGE_RELAY_PROFILE_WAKES_PER_HOUR tunes it). Queued messages deliver as the window rolls.`)
        return 0
      }
    }

    for (const m of g.messages) {
      if (claimQueued.run({ id: m.id, deliveredAt: now }).changes > 0) claimed.push(m)
    }
    if (claimed.length === 0) return 0
    const block = claimed.map(provenanceBlock).join('\n\n')
    try {
      await sendToSession(session.id, block, profileSender
        ? { from: { kind: 'profile', profileId: profileSender.fromProfileId ?? 'unknown' } }
        : undefined)
    } catch (err) {
      if (err instanceof BudgetCapError) {
        // Org budget capped: NOT a failure of the messages — put the claims back
        // and hold (queued rows retry every tick; delivery resumes when the cap
        // lifts). NB sendToSession appends the durable turn BEFORE dispatching,
        // so the batch's turn stays on the thread awaiting the wake — the next
        // successful establish replays it from the seed (ledgered INT.2 #8
        // posture; the failed-wake ghost-turn wave owns the deeper fix).
        for (const m of claimed) revertClaim.run({ id: m.id })
        claimed.length = 0
        notifyHoldOnce('budget', `org budget cap reached — agent-message delivery to ${g.profileId} held until the cap lifts: ${err.message}`)
        return 0
      }
      throw err // real failures keep the failed+notify path below
    }
    if (profileSender) profileWakeTimes.push(now)
    return claimed.length
  } catch (err) {
    if (claimed.length > 0) {
      for (const m of claimed) {
        try { failClaimed.run({ id: m.id }) } catch { /* keep degrading */ }
      }
      notifyDeliveryFailure(g.profileId, claimed.length, err)
    } else {
      console.warn(`[message-relay] conversation ${g.profileId}/${g.threadId} drain failed pre-claim:`, err)
    }
    return 0
  }
}

/**
 * Drain the queued mailbox once: group by conversation, deliver each group by the
 * target session's state. Never throws. Returns the number of messages delivered.
 */
export async function drainAgentMessages(): Promise<number> {
  if (draining) return 0
  draining = true
  try {
    const queued = (listAllQueued.all() as Record<string, unknown>[]).map(rowToAgentMessage)
    if (queued.length === 0) return 0
    const groups = new Map<string, ConversationGroup>()
    for (const m of queued) {
      let threadId = m.toThreadId
      if (threadId == null) {
        try {
          threadId = getOrCreateConversation(m.toProfileId).id
        } catch (err) {
          // Unresolvable target (deleted profile, unsafe id): fail the row loudly.
          if (agentMessagesDb.markFailed.run(m.id).changes > 0) {
            notifyDeliveryFailure(m.toProfileId, 1, err)
          }
          continue
        }
      }
      // \x1f (unit separator): structurally collision-safe — profile/thread ids
      // exclude control chars by construction, unlike a space which is merely
      // absent from today's id charsets by accident.
      const key = `${m.toProfileId}\x1f${threadId}`
      const g = groups.get(key) ?? { profileId: m.toProfileId, threadId, messages: [] }
      g.messages.push(m)
      groups.set(key, g)
    }
    let delivered = 0
    for (const g of groups.values()) delivered += await deliverConversation(g)
    return delivered
  } finally {
    draining = false
  }
}

/**
 * Start the MAIN-process message relay: poll + drain on an interval. Returns a stop
 * fn (mirrors startLeadDispatchRelay). Opt out via MESSAGE_RELAY=0. Interval:
 * MESSAGE_RELAY_INTERVAL_MS, default 2000ms; unref'd so it never holds the process.
 */
export function startMessageRelay(opts?: { intervalMs?: number }): () => void {
  if (process.env.MESSAGE_RELAY === '0') return () => { /* disabled — nothing wired */ }
  const intervalMs =
    opts?.intervalMs ?? (Number(process.env.MESSAGE_RELAY_INTERVAL_MS) || DEFAULT_RELAY_INTERVAL_MS)
  const timer = setInterval(() => {
    void drainAgentMessages().catch(() => { /* never crash the tick */ })
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
