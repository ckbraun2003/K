/**
 * Toast — auto-dismiss timer contract (wave C1). The countdown keys on
 * [open, durationMs, resetKey]:
 *   - without a resetKey change, an open toast dismisses once after durationMs
 *   - a resetKey change WHILE OPEN restarts the countdown from zero (a replaced
 *     pending-undo run must get a fresh full window, not the first run's dying timer)
 * Pure component test — fake timers + act, no QueryClient needed.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import Toast from '../src/components/Toast'

// jsdom has no matchMedia; framer-motion may probe it. Inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})
afterEach(() => cleanup())

describe('Toast auto-dismiss timer', () => {
  it('dismisses once after durationMs when the resetKey never changes', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<Toast open message="hi" resetKey="a" durationMs={5000} onDismiss={onDismiss} />)

      act(() => { vi.advanceTimersByTime(4999) })
      expect(onDismiss).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(2) })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a resetKey change while open restarts the countdown', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      const { rerender } = render(
        <Toast open message="run a" resetKey="a" durationMs={5000} onDismiss={onDismiss} />,
      )

      // 4s into run a's window, the subject is replaced (resetKey a → b).
      act(() => { vi.advanceTimersByTime(4000) })
      expect(onDismiss).not.toHaveBeenCalled()
      rerender(<Toast open message="run b" resetKey="b" durationMs={5000} onDismiss={onDismiss} />)

      // 4s more (8s total — past run a's original deadline): the restarted timer
      // must still be pending.
      act(() => { vi.advanceTimersByTime(4000) })
      expect(onDismiss).not.toHaveBeenCalled()

      // …and it fires at the FULL duration from the reset.
      act(() => { vi.advanceTimersByTime(1100) })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
