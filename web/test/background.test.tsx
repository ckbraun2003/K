/**
 * <Background/> (usability-access B.4) — route-agnostic ambient backdrop,
 * variant-driven by the operator's saved preference (GET /api/settings/background).
 * jsdom lacks a real 2D canvas + ResizeObserver, so both are stubbed below —
 * the galaxy case only needs to prove a <canvas> mounts under the expected
 * data-testid/data-variant, not that pixels are correct (starfield.test.ts
 * covers the pure draw math directly).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockBackgroundGet, mockReducedMotion } = vi.hoisted(() => ({
  mockBackgroundGet: vi.fn(),
  mockReducedMotion: vi.fn(() => false),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: mockBackgroundGet,
        set: vi.fn(),
      },
    },
  },
}))
// Control the reduced-motion branch of the galaxy canvas from tests.
vi.mock('../src/lib/motion', () => ({ prefersReducedMotion: mockReducedMotion }))

// ResizeObserver.disconnect routed through a shared spy so the unmount-cleanup
// test can assert the observer is actually disconnected.
const roDisconnect = vi.fn()

import Background from '../src/shell/Background'

const OPTIONS = ['galaxy', 'aurora', 'blobs', 'solid'] as const

beforeAll(() => {
  // jsdom has neither a real 2D canvas context nor ResizeObserver — the
  // galaxy variant's rAF loop needs both stubbed to mount without throwing.
  // @ts-expect-error minimal stub — disconnect routed through the shared spy
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() { roDisconnect() } }
  const noopCtx = {
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    setTransform: () => {},
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => noopCtx)
})

function renderBg() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Background />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockBackgroundGet.mockReset()
  mockReducedMotion.mockReturnValue(false)
  roDisconnect.mockClear()
})
afterEach(() => cleanup())

describe('Background', () => {
  it('galaxy: renders app-background with data-variant=galaxy and a <canvas>', async () => {
    mockBackgroundGet.mockResolvedValue({ variant: 'galaxy', options: OPTIONS })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('galaxy')
    })
    expect(screen.getByTestId('app-background').querySelector('canvas')).not.toBeNull()
  })

  it('blobs: uniform app-background contract + the four .ambient-blob layers', async () => {
    mockBackgroundGet.mockResolvedValue({ variant: 'blobs', options: OPTIONS })
    const { container } = renderBg()
    await waitFor(() => {
      expect(container.querySelectorAll('.ambient-blob').length).toBe(4)
    })
    // all four variants share one contract — blobs wraps <Ambient/> in the shell
    expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('blobs')
  })

  it('aurora: renders app-background with data-variant=aurora, no canvas', async () => {
    mockBackgroundGet.mockResolvedValue({ variant: 'aurora', options: OPTIONS })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('aurora')
    })
    expect(screen.getByTestId('app-background').querySelector('canvas')).toBeNull()
  })

  it('solid: renders app-background with data-variant=solid, no canvas', async () => {
    mockBackgroundGet.mockResolvedValue({ variant: 'solid', options: OPTIONS })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('solid')
    })
    expect(screen.getByTestId('app-background').querySelector('canvas')).toBeNull()
  })

  it('while loading, renders app-background without a canvas (no flash)', () => {
    mockBackgroundGet.mockReturnValue(new Promise(() => {})) // never resolves
    renderBg()
    const root = screen.getByTestId('app-background')
    expect(root.querySelector('canvas')).toBeNull()
  })

  it('galaxy under reduced-motion: draws statically, never schedules the rAF loop', async () => {
    mockReducedMotion.mockReturnValue(true)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    mockBackgroundGet.mockResolvedValue({ variant: 'galaxy', options: OPTIONS })
    const { unmount } = renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').querySelector('canvas')).not.toBeNull()
    })
    unmount()
    // reduced ⇒ `raf` was never set ⇒ cleanup has no animation frame to cancel.
    expect(cancelSpy).not.toHaveBeenCalled()
    cancelSpy.mockRestore()
  })

  it('galaxy: cancels the rAF loop + disconnects ResizeObserver on unmount', async () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    mockBackgroundGet.mockResolvedValue({ variant: 'galaxy', options: OPTIONS })
    const { unmount } = renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').querySelector('canvas')).not.toBeNull()
    })
    unmount()
    expect(cancelSpy).toHaveBeenCalled()
    expect(roDisconnect).toHaveBeenCalled()
    cancelSpy.mockRestore()
  })
})
