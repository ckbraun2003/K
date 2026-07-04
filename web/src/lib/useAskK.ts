import { useCallback, useRef, useState } from 'react'
import type { KRoute, KForceRoute } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { api } from './api'
import { navigate } from './route'

/** The just-started run held while the 5s Undo window is open. */
export interface PendingUndo {
  /** Stable per-send id. The undo window/toast anchors to THIS (the send action),
   *  NOT to `runId` — so the 5s timer starts at the click and only restarts on a NEW
   *  send, not when the in-flight dispatch resolves and patches `runId` in (F-066).
   *  Consumers pass this to the Toast's `resetKey`. */
  key: number
  /** null while the ask is IN FLIGHT (raised optimistically on send); patched to the
   *  started run id once `api.k.ask` resolves. Undo pressed before it resolves is
   *  honored the moment the id exists (F-066). */
  runId: string | null
  route: KRoute
}

/**
 * Shared "ask K + 5s undo" orchestration (P5.1f) — extracted from CommandBar so
 * both ⌘K and K-home drive the front door identically.
 *
 * `send` is optimistic AND anchors the undo window to the SEND action (F-066): it
 * raises the Undo affordance IMMEDIATELY (via `pendingUndo`, with the previewed route
 * and no `runId` yet), so the 5s countdown measures from the click — not from the
 * (~1.5s later) dispatch resolution, which would leave an operator (or automation)
 * with far less than the advertised window. When `api.k.ask` resolves the started
 * `runId` is patched in WITHOUT changing `key`, so the toast keeps its original
 * send-anchored timer instead of restarting. A failed dispatch clears the optimistic
 * window (nothing was started). Navigation is CALLER-CHOSEN via `navigateOnSend`
 * (default true): ⌘K navigates on resolve because its Undo toast is rendered outside
 * the palette and survives the close; K-home passes `false` and stays put — navigating
 * would unmount the page and kill its own Undo toast, so it offers a "View run" link on
 * the toast instead. `undo` best-effort kills the started run; pressed while the ask is
 * still in flight, it kills the run as soon as its id resolves. A trimmed-empty message
 * is a no-op. Re-entry is guarded by a synchronous ref so a double click/Enter can't
 * fire two asks.
 */
export function useAskK(opts?: { navigateOnSend?: boolean }) {
  const navigateOnSend = opts?.navigateOnSend ?? true
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  // Monotonic per-send counter — the stable, send-anchored window key (PendingUndo.key).
  const sendSeq = useRef(0)
  // The send key whose Undo was pressed BEFORE its runId resolved: the resolve handler
  // kills the run the moment its id exists (undo can't wait on the dispatch) — F-066.
  const undoBeforeResolve = useRef<number | null>(null)

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
    // Anchor the undo window to the SEND action (F-066): raise the affordance NOW —
    // with the previewed route (the same shared mapping the server applies) and no
    // runId yet — so the 5s countdown starts at the click, not at the later resolve.
    const key = (sendSeq.current += 1)
    undoBeforeResolve.current = null
    const route = opts?.forceRoute ? routeForTarget(opts.forceRoute) : routeForMessage(msg)
    setPendingUndo({ key, runId: null, route })
    try {
      const result = await api.k.ask(msg, opts)
      // Undo was pressed while the ask was in flight → kill now that the id exists.
      // The window is already closed (undo nulled pendingUndo); don't re-raise or
      // navigate to a run the operator just undid.
      if (undoBeforeResolve.current === key) {
        undoBeforeResolve.current = null
        try { await api.k.undo(result.runId) } catch { /* best-effort */ }
        return true
      }
      // Patch the resolved runId (and the authoritative server route) into the SAME
      // window — `key` unchanged, so the toast's send-anchored timer is NOT restarted.
      // Guard on `key` so a newer send that already superseded this one isn't clobbered.
      setPendingUndo(prev => (prev && prev.key === key ? { ...prev, runId: result.runId, route: result.route } : prev))
      if (navigateOnSend) navigate('runs', result.runId)
      return true
    } catch (e) {
      // Dispatch failed → clear this send's optimistic window (nothing to undo).
      setPendingUndo(prev => (prev && prev.key === key ? null : prev))
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [navigateOnSend])

  // Capture the pending run into a local BEFORE clearing so the caller's onDismiss
  // (which also nulls pendingUndo) can't race the read. Uses the K undo endpoint (not
  // a bare runs.kill): it kills the run AND removes the dangling turns the ask appended,
  // so the undone message is never replayed into a later seed (F-060). Pressed while the
  // ask is STILL IN FLIGHT (no runId yet), it records the intent so send()'s resolve
  // handler kills the run as soon as its id exists (F-066).
  const undo = useCallback(async () => {
    const cur = pendingUndo
    if (!cur) return
    setPendingUndo(null)
    if (cur.runId == null) {
      undoBeforeResolve.current = cur.key
      return
    }
    try { await api.k.undo(cur.runId) } catch { /* best-effort */ }
  }, [pendingUndo])

  const clearUndo = useCallback(() => setPendingUndo(null), [])

  return { send, undo, clearUndo, pendingUndo, busy, error, setError }
}
