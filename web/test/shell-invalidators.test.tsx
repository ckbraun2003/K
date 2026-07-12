/**
 * UI Simplification Task 10 — the WS-invalidator subscription has exactly ONE
 * owner: Shell, via this hook. Ports ActivityStrip's wiring (ActivityStrip.tsx:20-43)
 * PLUS KHome's makeFeedInvalidator effect (KHome.tsx:79-82) PLUS raiseBrowserNotification
 * into one unit, so invalidation never depends on which page happens to be mounted
 * (activity-strip.test.tsx's mock block is the template for the mocks below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { WsMessage } from '@k/shared'

const {
  capturedHandler, unsubscribeSpy, runUpdateHandler, runUpdateDispose,
  projectListSpy, capabilitiesSpy, verifySpy, inboxSpy, feedSpy, notifySpy,
} = vi.hoisted(() => ({
  capturedHandler: { current: null as ((msg: WsMessage) => void) | null },
  unsubscribeSpy: vi.fn(),
  runUpdateHandler: vi.fn(),
  runUpdateDispose: vi.fn(),
  projectListSpy: vi.fn(),
  capabilitiesSpy: vi.fn(),
  verifySpy: vi.fn(),
  inboxSpy: vi.fn(),
  feedSpy: vi.fn(),
  notifySpy: vi.fn(),
}))

vi.mock('../src/lib/ws', () => ({
  onWsMessage: (h: (msg: WsMessage) => void) => {
    capturedHandler.current = h
    return unsubscribeSpy
  },
}))

vi.mock('../src/lib/live-invalidate', () => ({
  makeRunUpdateInvalidator: () => ({ handler: runUpdateHandler, dispose: runUpdateDispose }),
  makeProjectListInvalidator: () => projectListSpy,
  makeCapabilitiesInvalidator: () => capabilitiesSpy,
  makeVerifyInvalidator: () => verifySpy,
  makeInboxInvalidator: () => inboxSpy,
  // P3 E-09's feed invalidator — was KHome-owned (KHome.tsx:79-82); Task 10 moves
  // it here so the Org Timeline feed refreshes live even though KHome no longer mounts.
  makeFeedInvalidator: () => feedSpy,
}))

vi.mock('../src/lib/notifications', () => ({ raiseBrowserNotification: notifySpy }))

import useLiveInvalidators from '../src/shell/useLiveInvalidators'

const msg = { type: 'run_update', run: { id: 'r1', status: 'running' } } as unknown as WsMessage

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  capturedHandler.current = null
  unsubscribeSpy.mockClear()
  runUpdateHandler.mockClear()
  runUpdateDispose.mockClear()
  projectListSpy.mockClear()
  capabilitiesSpy.mockClear()
  verifySpy.mockClear()
  inboxSpy.mockClear()
  feedSpy.mockClear()
  notifySpy.mockClear()
})
afterEach(() => cleanup())

describe('useLiveInvalidators', () => {
  it('subscribes exactly once and fans one message out to every invalidator + the browser notifier', () => {
    renderHook(() => useLiveInvalidators(), { wrapper })
    expect(capturedHandler.current).not.toBeNull()

    capturedHandler.current!(msg)

    expect(runUpdateHandler).toHaveBeenCalledWith(msg)
    expect(projectListSpy).toHaveBeenCalledWith(msg)
    expect(capabilitiesSpy).toHaveBeenCalledWith(msg)
    expect(verifySpy).toHaveBeenCalledWith(msg)
    expect(inboxSpy).toHaveBeenCalledWith(msg)
    expect(feedSpy).toHaveBeenCalledWith(msg)
    expect(notifySpy).toHaveBeenCalledWith(msg)
  })

  it('disposes the throttled run-update invalidator and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useLiveInvalidators(), { wrapper })
    unmount()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    expect(runUpdateDispose).toHaveBeenCalledTimes(1)
  })

  it('fires with no page mounted at all — the hook alone drives invalidation (Shell-only ownership)', () => {
    // renderHook mounts nothing but the hook itself — no KHome, no ActivityStrip,
    // no RunsPage anywhere in the tree. That is the point of Task 10: invalidation
    // can never again depend on which page happens to be routed.
    renderHook(() => useLiveInvalidators(), { wrapper })
    capturedHandler.current!(msg)
    expect(runUpdateHandler).toHaveBeenCalledTimes(1)
  })
})
