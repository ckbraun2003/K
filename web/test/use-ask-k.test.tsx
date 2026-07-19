/**
 * useAskK — the shared "ask K + 5s undo" orchestration extracted from CommandBar
 * (P5.1f). Both ⌘K and K-home drive it. The contract under test:
 *   - send(msg) calls api.k.ask once with the message, navigates to ('runs', runId),
 *     and sets pendingUndo to the returned run.
 *   - a trimmed-empty message is a no-op (no ask, no navigate).
 *   - useAskK({ navigateOnSend: false }) sends + sets pendingUndo WITHOUT navigating
 *     (the K-home policy — wave C1); the default stays navigate-on-send (⌘K).
 *   - undo() undoes the pending run once via api.k.undo (kill + dangling-turn removal,
 *     F-060) and clears pendingUndo.
 *   - a rejected send surfaces the error and leaves pendingUndo null.
 * api + route.navigate are mocked (vi.hoisted, mirroring command-bar-ask-k.test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeForMessage, routeForTarget } from '@k/shared'

const { mockAsk, mockUndo, mockNavigate } = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockUndo: vi.fn(async () => ({ undone: true })),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: mockAsk, undo: mockUndo },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'home' }),
}))

import { useAskK } from '../src/lib/useAskK'

const MSG = 'refactor the auth module'

// useAskK now reads useQueryClient (Task 7's thread-key invalidation), so every
// renderHook needs a QueryClientProvider in scope — a fresh client per call, since
// the counted invalidateQueries mock cache-state doesn't need to persist across tests.
function renderAskK(opts?: { navigateOnSend?: boolean }) {
  const qc = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return renderHook(() => useAskK(opts), { wrapper })
}

beforeEach(() => {
  mockAsk.mockReset()
  mockUndo.mockClear()
  mockNavigate.mockClear()
  mockAsk.mockImplementation(async (message: string) => ({
    kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(message), warm: false,
  }))
})

describe('useAskK', () => {
  it('send calls api.k.ask once, navigates to the run, sets pendingUndo', async () => {
    const { result } = renderAskK()

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(true) // resolves true on success so a caller can clear its composer
    expect(mockAsk).toHaveBeenCalledTimes(1)
    // No opts passed → api.k.ask receives an explicit undefined opts arg.
    expect(mockAsk).toHaveBeenCalledWith(MSG, undefined)
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123')
    // pendingUndo also carries a per-send `key` (the send-anchored window id, F-066).
    expect(result.current.pendingUndo).toMatchObject({ runId: 'run-123', route: routeForMessage(MSG) })
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('passes the power-control opts (model / forceRoute) through to api.k.ask untouched', async () => {
    const { result } = renderAskK({ navigateOnSend: false })

    await act(async () => {
      await result.current.send(MSG, { model: 'claude-opus-4-8', forceRoute: 'chief' })
    })

    expect(mockAsk).toHaveBeenCalledTimes(1)
    expect(mockAsk).toHaveBeenCalledWith(MSG, { model: 'claude-opus-4-8', forceRoute: 'chief' })
  })

  it('a trimmed-empty message is a no-op', async () => {
    const { result } = renderAskK()

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send('   ') })

    expect(ok).toBe(false) // empty → not sent
    expect(mockAsk).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.pendingUndo).toBeNull()
  })

  it('navigateOnSend:false sends + sets pendingUndo without navigating (K-home policy)', async () => {
    const { result } = renderAskK({ navigateOnSend: false })

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(true)
    expect(mockAsk).toHaveBeenCalledTimes(1)
    expect(mockAsk).toHaveBeenCalledWith(MSG, undefined)
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.pendingUndo).toMatchObject({ runId: 'run-123', route: routeForMessage(MSG) })
  })

  it('undo undoes the pending run once via api.k.undo and clears pendingUndo', async () => {
    const { result } = renderAskK()

    await act(async () => { await result.current.send(MSG) })
    expect(result.current.pendingUndo).not.toBeNull()

    await act(async () => { await result.current.undo() })

    // api.k.undo (not a bare runs.kill) so the dangling turns are removed too (F-060).
    expect(mockUndo).toHaveBeenCalledTimes(1)
    expect(mockUndo).toHaveBeenCalledWith('run-123')
    expect(result.current.pendingUndo).toBeNull()
  })

  it('undo with no pending run is a no-op', async () => {
    const { result } = renderAskK()
    await act(async () => { await result.current.undo() })
    expect(mockUndo).not.toHaveBeenCalled()
  })

  it('clearUndo nulls pendingUndo without undoing', async () => {
    const { result } = renderAskK()
    await act(async () => { await result.current.send(MSG) })

    act(() => { result.current.clearUndo() })

    expect(result.current.pendingUndo).toBeNull()
    expect(mockUndo).not.toHaveBeenCalled()
  })

  it('a rejected send surfaces the error and leaves pendingUndo null', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    const { result } = renderAskK()

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(false) // failure → not sent, so the caller keeps its text
    await waitFor(() => expect(result.current.error).toBe('kaboom'))
    expect(result.current.pendingUndo).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  // ── F-066: the undo window is anchored to the SEND action, not the resolve ──

  it('raises the undo window at SEND — pendingUndo (runId null, previewed route) is set BEFORE the ask resolves', async () => {
    // A deferred ask: the promise stays pending until we resolve it, so we can observe
    // the state WHILE the dispatch is in flight.
    let resolveAsk!: (v: unknown) => void
    mockAsk.mockImplementationOnce(() => new Promise(r => { resolveAsk = r }))
    const { result } = renderAskK({ navigateOnSend: false })

    let sendPromise!: Promise<boolean>
    act(() => { sendPromise = result.current.send(MSG) })

    // In flight: the affordance is already up (window/timer started at the click),
    // with the previewed route and no runId yet.
    expect(result.current.pendingUndo).not.toBeNull()
    expect(result.current.pendingUndo!.runId).toBeNull()
    expect(result.current.pendingUndo!.route).toEqual(routeForMessage(MSG))
    const windowKey = result.current.pendingUndo!.key

    // Resolve → runId patched into the SAME window (key unchanged, so the toast's
    // send-anchored 5s timer is not restarted).
    await act(async () => {
      resolveAsk({ kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(MSG), warm: false })
      await sendPromise
    })
    expect(result.current.pendingUndo!.runId).toBe('run-123')
    expect(result.current.pendingUndo!.key).toBe(windowKey)
  })

  it('undo pressed BEFORE the runId resolves kills the run once its id exists (F-066)', async () => {
    let resolveAsk!: (v: unknown) => void
    mockAsk.mockImplementationOnce(() => new Promise(r => { resolveAsk = r }))
    const { result } = renderAskK({ navigateOnSend: false })

    let sendPromise!: Promise<boolean>
    act(() => { sendPromise = result.current.send(MSG) })

    // Undo while the ask is still in flight (no runId to kill yet) — the window closes
    // immediately, but the kill can't fire until the id exists.
    await act(async () => { await result.current.undo() })
    expect(result.current.pendingUndo).toBeNull()
    expect(mockUndo).not.toHaveBeenCalled()

    // The ask resolves → the deferred undo fires with the now-known runId, exactly once,
    // and we never navigate to a run the operator undid.
    await act(async () => {
      resolveAsk({ kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(MSG), warm: false })
      await sendPromise
    })
    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('run-123'))
    expect(mockUndo).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('a failed send clears the optimistic window (no lingering undo affordance)', async () => {
    mockAsk.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderAskK({ navigateOnSend: false })

    await act(async () => { await result.current.send(MSG) })

    // The optimistic window is torn back down — nothing started, nothing to undo.
    expect(result.current.pendingUndo).toBeNull()
    expect(mockUndo).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })

  // ── A.4 (D-126): a FORCED route queues a mailbox message — runId null ──────

  it('a FORCED send raises NO undo window and never navigates — the queued shape (runId null) has nothing to undo', async () => {
    mockAsk.mockImplementationOnce(async () => ({
      kThreadId: 'kt', agentRunId: null, runId: null, messageId: 'm1',
      route: routeForTarget('chief'), warm: false,
    }))
    const { result } = renderAskK() // default navigateOnSend:true — the null runId must still not navigate

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG, { forceRoute: 'chief' }) })

    expect(ok).toBe(true) // the message WAS queued — the caller clears its composer
    expect(mockAsk).toHaveBeenCalledWith(MSG, { forceRoute: 'chief' })
    expect(result.current.pendingUndo).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })

  it('no optimistic window exists even WHILE a forced send is in flight (nothing dispatched to undo)', async () => {
    let resolveAsk!: (v: unknown) => void
    mockAsk.mockImplementationOnce(() => new Promise(r => { resolveAsk = r }))
    const { result } = renderAskK({ navigateOnSend: false })

    let sendPromise!: Promise<boolean>
    act(() => { sendPromise = result.current.send(MSG, { forceRoute: 'frontend' }) })

    // In flight: no affordance at all — a forced route will queue, not dispatch.
    expect(result.current.pendingUndo).toBeNull()

    await act(async () => {
      resolveAsk({ kThreadId: 'kt', agentRunId: null, runId: null, messageId: 'm2', route: routeForTarget('frontend'), warm: false })
      await sendPromise
    })
    expect(result.current.pendingUndo).toBeNull()
    expect(mockUndo).not.toHaveBeenCalled()
  })

  it('an UNFORCED send that resolves runId:null clears the optimistic window (defensive — no dangling affordance)', async () => {
    mockAsk.mockImplementationOnce(async () => ({
      kThreadId: 'kt', agentRunId: null, runId: null, messageId: 'm3',
      route: routeForMessage(MSG), warm: false,
    }))
    const { result } = renderAskK({ navigateOnSend: false })

    await act(async () => { await result.current.send(MSG) })

    expect(result.current.pendingUndo).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
