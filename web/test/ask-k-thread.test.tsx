/**
 * useAskK send() threadId + query-key invalidation (UI Simplification Task 7).
 * send() passes an optional threadId through to api.k.ask untouched (rides the
 * same opts spread as model/forceRoute — Task 2's threaded ask), and on a
 * successful resolve invalidates BOTH the ['k-thread'] prefix (covers the legacy
 * singleton key AND every scoped ['k-thread', id] detail) and ['k-threads'] (the
 * list) — so a thread surface (Task 11+/15) never goes stale until reload.
 * api + route are mocked (mirrors use-ask-k.test.tsx's idiom).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// vi.hoisted — vi.mock factories are hoisted above top-level consts, so a plain
// `const askMock = vi.fn()` referenced inside the factory below throws a TDZ
// ReferenceError (mirrors use-ask-k.test.tsx / command-bar-ask-k.test.tsx's idiom).
const { askMock } = vi.hoisted(() => ({
  askMock: vi.fn(async () => ({ runId: 'r1', route: { target: 'k', label: 'K answers directly', escalates: false } })),
}))
vi.mock('../src/lib/api', () => ({ api: { k: { ask: askMock, undo: vi.fn() } } }))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
import { useAskK } from '../src/lib/useAskK'

describe('useAskK send() threadId + thread-key invalidation', () => {
  it('send() forwards threadId to api.k.ask and invalidates both thread keys', async () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useAskK({ navigateOnSend: false }), { wrapper })
    await act(async () => { await result.current.send('hello', { threadId: 'kt-42' }) })
    expect(askMock).toHaveBeenCalledWith('hello', expect.objectContaining({ threadId: 'kt-42' }))
    const keys = spy.mock.calls.map(c => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
    expect(keys).toContain(JSON.stringify(['k-thread']))
    expect(keys).toContain(JSON.stringify(['k-threads']))
  })
})
