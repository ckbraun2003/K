/**
 * EventBus — the Architecture-B seam.
 *
 * emit(e) does two things atomically:
 *   1. Appends the event as an immutable row to the `events` SQLite table
 *   2. Pushes it to all registered in-process subscribers (WebSocket gateway)
 *
 * When/if we promote to a real message bus (NATS / Redis Streams), only this
 * file changes — every call site stays the same.
 */

import type { AgentEvent, Run, WsMessage } from '@k/shared'
import { eventsDb, runsDb } from './db.js'

type EventSubscriber = (e: AgentEvent) => void
type RunSubscriber = (r: Run) => void

const eventSubs = new Set<EventSubscriber>()
const runSubs = new Set<RunSubscriber>()
const broadcastSubs = new Set<(m: WsMessage) => void>()

export const eventBus = {
  // ── subscribe / unsubscribe ───────────────────────────────────────────────

  onEvent(fn: EventSubscriber): () => void {
    eventSubs.add(fn)
    return () => eventSubs.delete(fn)
  },

  onRunUpdate(fn: RunSubscriber): () => void {
    runSubs.add(fn)
    return () => runSubs.delete(fn)
  },

  // ── emit ──────────────────────────────────────────────────────────────────

  emitEvent(e: AgentEvent): void {
    // Persist first — if we crash immediately after, the event is not lost
    eventsDb.insertEvent.run({
      id: e.id,
      runId: e.runId,
      seq: e.seq,
      type: e.type,
      ts: e.ts,
      raw: e.raw ?? null,
      text: e.text ?? null,
      tool: e.tool ?? null,
      tokensIn: e.tokensIn ?? null,
      tokensOut: e.tokensOut ?? null,
      costUsd: e.costUsd ?? null,
    })
    // Then push to live subscribers
    for (const sub of eventSubs) {
      try { sub(e) } catch { /* subscriber errors must not kill the bus */ }
    }
  },

  emitRunUpdate(r: Run): void {
    runsDb.updateRunStatus.run({
      id: r.id,
      status: r.status,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costUsd: r.costUsd,
      endedAt: r.endedAt ?? null,
    })
    for (const sub of runSubs) {
      try { sub(r) } catch { /* same */ }
    }
  },

  // ── generic broadcast (github_update, verification_update, …) ────────────
  // Not persisted — transient UI state. Durable facts live in their own tables.

  onBroadcast(fn: (m: WsMessage) => void): () => void {
    broadcastSubs.add(fn)
    return () => broadcastSubs.delete(fn)
  },

  broadcast(m: WsMessage): void {
    for (const sub of broadcastSubs) {
      try { sub(m) } catch { /* subscriber errors must not kill the bus */ }
    }
  },
}
