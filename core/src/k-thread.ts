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
import type { KThread, KThreadTurn, KAskResult } from '@k/shared'
import { routeForMessage } from '@k/shared'
import { kThreadsDb, runsDb, eventsDb } from './db.js'
import { eventBus } from './events.js'
import { startAgentRun } from './agent-runs.js'
import { sendInput } from './supervisor.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

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

// ── the front door ───────────────────────────────────────────────────────────

/**
 * Activate K for one message (D-023). Records the user's ask as a durable turn (the
 * source of truth), then either CONTINUES the warm interactive run (feed the turn via
 * sendInput) or starts a FRESH interactive run seeded from the thread. Returns the
 * thread id, the run id, the deterministic route PREVIEW, and whether it was warm.
 */
export async function askK(message: string): Promise<KAskResult> {
  const thread = ensureDefaultKThread()
  const route = routeForMessage(message)

  // The durable ask — recorded up front so it survives even if the dispatch below
  // throws (startAgentRun rolls back only its own agent_runs row; the ask stays,
  // which is acceptable: the thread is the source of truth for what was asked).
  const turn = appendTurn(thread.id, 'user', message, null)

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
