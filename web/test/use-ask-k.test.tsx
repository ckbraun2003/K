/**
 * useAskK — the shared "ask K + 5s undo" orchestration extracted from CommandBar
 * (P5.1f). Both ⌘K and K-home drive it. The contract under test:
 *   - send(msg) calls api.k.ask once with the message, navigates to ('runs', runId),
 *     and sets pendingUndo to the returned run.
 *   - a trimmed-empty message is a no-op (no ask, no navigate).
 *   - useAskK({ navigateOnSend: false }) sends + sets pendingUndo WITHOUT navigating
 *     (the K-home policy — wave C1); the default stays navigate-on-send (⌘K).
 *   - undo() kills the pending run once via api.runs.kill and clears pendingUndo.
 *   - a rejected send surfaces the error and leaves pendingUndo null.
 * api + route.navigate are mocked (vi.hoisted, mirroring command-bar-ask-k.test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { routeForMessage } from '@k/shared'

const { mockAsk, mockKill, mockNavigate } = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockKill: vi.fn(async () => ({ killed: true })),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: mockAsk },
    runs: { kill: mockKill },
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

beforeEach(() => {
  mockAsk.mockReset()
  mockKill.mockClear()
  mockNavigate.mockClear()
  mockAsk.mockImplementation(async (message: string) => ({
    kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(message), warm: false,
  }))
})

describe('useAskK', () => {
  it('send calls api.k.ask once, navigates to the run, sets pendingUndo', async () => {
    const { result } = renderHook(() => useAskK())

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(true) // resolves true on success so a caller can clear its composer
    expect(mockAsk).toHaveBeenCalledTimes(1)
    // No opts passed → api.k.ask receives an explicit undefined opts arg.
    expect(mockAsk).toHaveBeenCalledWith(MSG, undefined)
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123')
    expect(result.current.pendingUndo).toEqual({ runId: 'run-123', route: routeForMessage(MSG) })
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('passes the power-control opts (model / forceRoute) through to api.k.ask untouched', async () => {
    const { result } = renderHook(() => useAskK({ navigateOnSend: false }))

    await act(async () => {
      await result.current.send(MSG, { model: 'claude-opus-4-8', forceRoute: 'chief' })
    })

    expect(mockAsk).toHaveBeenCalledTimes(1)
    expect(mockAsk).toHaveBeenCalledWith(MSG, { model: 'claude-opus-4-8', forceRoute: 'chief' })
  })

  it('a trimmed-empty message is a no-op', async () => {
    const { result } = renderHook(() => useAskK())

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send('   ') })

    expect(ok).toBe(false) // empty → not sent
    expect(mockAsk).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.pendingUndo).toBeNull()
  })

  it('navigateOnSend:false sends + sets pendingUndo without navigating (K-home policy)', async () => {
    const { result } = renderHook(() => useAskK({ navigateOnSend: false }))

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(true)
    expect(mockAsk).toHaveBeenCalledTimes(1)
    expect(mockAsk).toHaveBeenCalledWith(MSG, undefined)
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.pendingUndo).toEqual({ runId: 'run-123', route: routeForMessage(MSG) })
  })

  it('undo kills the pending run once and clears pendingUndo', async () => {
    const { result } = renderHook(() => useAskK())

    await act(async () => { await result.current.send(MSG) })
    expect(result.current.pendingUndo).not.toBeNull()

    await act(async () => { await result.current.undo() })

    expect(mockKill).toHaveBeenCalledTimes(1)
    expect(mockKill).toHaveBeenCalledWith('run-123')
    expect(result.current.pendingUndo).toBeNull()
  })

  it('undo with no pending run is a no-op', async () => {
    const { result } = renderHook(() => useAskK())
    await act(async () => { await result.current.undo() })
    expect(mockKill).not.toHaveBeenCalled()
  })

  it('clearUndo nulls pendingUndo without killing', async () => {
    const { result } = renderHook(() => useAskK())
    await act(async () => { await result.current.send(MSG) })

    act(() => { result.current.clearUndo() })

    expect(result.current.pendingUndo).toBeNull()
    expect(mockKill).not.toHaveBeenCalled()
  })

  it('a rejected send surfaces the error and leaves pendingUndo null', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    const { result } = renderHook(() => useAskK())

    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send(MSG) })

    expect(ok).toBe(false) // failure → not sent, so the caller keeps its text
    await waitFor(() => expect(result.current.error).toBe('kaboom'))
    expect(result.current.pendingUndo).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })
})
