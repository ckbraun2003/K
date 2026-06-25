/**
 * Shared unauthorized-notification fan-out.
 *
 * Both the REST layer (api.ts, on a 401) and the WS layer (ws.ts, on a 4401
 * close) need to surface the login screen via the SAME path. Keeping the
 * handler set here breaks the otherwise-circular import (ws.ts → api.ts → ws.ts).
 */

/** Notified when the operator must (re)authenticate (REST 401 or WS 4401). */
const unauthorizedHandlers = new Set<() => void>()

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedHandlers.add(fn)
  return () => unauthorizedHandlers.delete(fn)
}

export function notifyUnauthorized(): void {
  for (const fn of unauthorizedHandlers) {
    try { fn() } catch { /* ignore */ }
  }
}
