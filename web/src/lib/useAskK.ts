import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { KRoute, KForceRoute } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { api } from './api'
import { navigate } from './route'
import { setAskPending } from './ask-pending'

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
 * Shared "ask K + 5s undo" orchestration (P5.1f) — used by MessageDock (the one
 * front door, both its bar and float variants) and org/TreeView's per-lead ask
 * affordance, so both drive K identically.
 *
 * `send` is optimistic AND anchors the undo window to the SEND action (F-066): it
 * raises the Undo affordance IMMEDIATELY (via `pendingUndo`, with the previewed route
 * and no `runId` yet), so the 5s countdown measures from the click — not from the
 * (~1.5s later) dispatch resolution, which would leave an operator (or automation)
 * with far less than the advertised window. When `api.k.ask` resolves the started
 * `runId` is patched in WITHOUT changing `key`, so the toast keeps its original
 * send-anchored timer instead of restarting. A failed dispatch clears the optimistic
 * window (nothing was started). A successful send also invalidates the `['k-thread']`
 * PREFIX (covers every scoped `['k-thread', id]` detail read, e.g. ChatView's
 * transcript) and the `['k-threads']` list (UI Simplification Task 7), so a thread
 * surface reading either key sees the new turn without waiting for reload.
 * Navigation is CALLER-CHOSEN via `navigateOnSend` (default true; both current
 * callers pass `false` and stay put — navigating on resolve would unmount the page
 * and kill its own Undo toast). `undo` best-effort kills the started run; pressed
 * while the ask is still in flight, it kills the run as soon as its id resolves.
 * A trimmed-empty message is a no-op. Re-entry is guarded by a synchronous ref so
 * a double click/Enter can't fire two asks.
 */
export function useAskK(opts?: { navigateOnSend?: boolean }) {
  const navigateOnSend = opts?.navigateOnSend ?? true
  const qc = useQueryClient()
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
    opts?: { model?: string; forceRoute?: KForceRoute; threadId?: string },
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
    // Impressive Wave FE Task 9: name the in-flight ask's target thread so ChatView
    // can render a "K is thinking..." indicator on that thread's transcript. `null`
    // for callers that don't pass a threadId (org/TreeView) — a harmless no-op.
    setAskPending(opts?.threadId ?? null)
    try {
      const result = await api.k.ask(msg, opts)
      // A successful ask appended a turn (and may have created/renamed a thread) —
      // refresh both the thread-detail prefix and the thread list so a Chats
      // surface (Task 11+/15) doesn't go stale until the next reload. `['k-thread']`
      // is a PREFIX match: it also invalidates every scoped `['k-thread', id]`.
      void qc.invalidateQueries({ queryKey: ['k-thread'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] })
      // Undo was pressed while the ask was in flight → kill now that the id exists.
      // The window is already closed (undo nulled pendingUndo); don't re-raise or
      // navigate to a run the operator just undid.
      if (undoBeforeResolve.current === key) {
        undoBeforeResolve.current = null
        try { await api.k.undo(result.runId) } catch { /* best-effort */ }
        // Re-refresh AFTER the undo: the success invalidation above raced the appended
        // turn INTO the cache; the undo then removed it server-side, so re-invalidate to
        // drop it from any thread surface reading these keys (M-D2).
        void qc.invalidateQueries({ queryKey: ['k-thread'] })
        void qc.invalidateQueries({ queryKey: ['k-threads'] })
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
      setAskPending(null)
    }
  }, [navigateOnSend, qc])

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
    // The undo removed the appended turn(s) server-side; drop them from the cache so an
    // undone message doesn't linger in the transcript. A fast one-shot that already reached
    // terminal inside the 5s window gets NO ws run_update (kill() is a no-op), so without
    // this the ChatView transcript would keep showing the undone turn until an unrelated
    // later invalidation (M-D2).
    void qc.invalidateQueries({ queryKey: ['k-thread'] })
    void qc.invalidateQueries({ queryKey: ['k-threads'] })
  }, [pendingUndo, qc])

  const clearUndo = useCallback(() => setPendingUndo(null), [])

  return { send, undo, clearUndo, pendingUndo, busy, error, setError }
}
