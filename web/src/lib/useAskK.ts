import { useCallback, useRef, useState } from 'react'
import type { KRoute, KForceRoute } from '@k/shared'
import { api } from './api'
import { navigate } from './route'

/** The just-started run held while the 5s Undo window is open. */
export interface PendingUndo {
  runId: string
  route: KRoute
}

/**
 * Shared "ask K + 5s undo" orchestration (P5.1f) — extracted from CommandBar so
 * both ⌘K and K-home drive the front door identically.
 *
 * `send` is optimistic: it raises the Undo window (via `pendingUndo`) and — by
 * default — opens the run console immediately. Navigation is CALLER-CHOSEN via
 * `navigateOnSend` (default true): ⌘K navigates on send because its Undo toast is
 * rendered outside the palette and survives the close; K-home passes `false` and
 * stays put — navigating would unmount the page and kill its own Undo toast, so
 * it offers a "View run" link on the toast instead. `undo` best-effort kills the
 * started run. A trimmed-empty message is a no-op. Re-entry is guarded by a
 * synchronous ref so a double click/Enter can't fire two asks.
 */
export function useAskK(opts?: { navigateOnSend?: boolean }) {
  const navigateOnSend = opts?.navigateOnSend ?? true
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  // Resolves `true` when the message was sent (run started + undo window open),
  // `false` on a trimmed-empty / re-entrant call or a dispatch failure — so a
  // caller can clear its composer on success only and keep the text on failure.
  // `opts` are the per-ask power controls (model override / forced route), passed
  // through to api.k.ask untouched.
  const send = useCallback(async (
    message: string,
    opts?: { model?: string; forceRoute?: KForceRoute },
  ): Promise<boolean> => {
    const msg = message.trim()
    if (!msg) return false
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await api.k.ask(msg, opts)
      setPendingUndo({ runId: result.runId, route: result.route })
      if (navigateOnSend) navigate('runs', result.runId)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [navigateOnSend])

  // Capture the pending run id into a local BEFORE clearing so the caller's
  // onDismiss (which also nulls pendingUndo) can't race the read.
  const undo = useCallback(async () => {
    if (!pendingUndo) return
    const runId = pendingUndo.runId
    setPendingUndo(null)
    try { await api.runs.kill(runId) } catch { /* best-effort */ }
  }, [pendingUndo])

  const clearUndo = useCallback(() => setPendingUndo(null), [])

  return { send, undo, clearUndo, pendingUndo, busy, error, setError }
}
