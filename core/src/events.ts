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
      // Enriched tool metadata (Wave D3). Object columns are JSON-stringified
      // when present (guard: JSON.stringify(undefined) is undefined, not a
      // string, which better-sqlite3 rejects). is_error → 1/0/null tri-state.
      toolUseId: e.toolUseId ?? null,
      toolKind: e.toolKind ?? null,
      toolInput: e.toolInput !== undefined ? JSON.stringify(e.toolInput) : null,
      toolResult: e.toolResult !== undefined ? JSON.stringify(e.toolResult) : null,
      toolResultIsError: e.toolResultIsError === undefined ? null : e.toolResultIsError ? 1 : 0,
      subagentType: e.subagentType ?? null,
      childLabel: e.childLabel ?? null,
      // Context size for the indicator (Wave D6) — a plain number, persisted so a
      // reloaded run shows true pressure (not the cache-excluding tokensIn).
      contextTokens: e.contextTokens ?? null,
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
