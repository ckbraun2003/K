import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCountUp } from '../src/lib/use-count-up'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('useCountUp', () => {
  it('interpolates 0 → value on mount and settles exactly on value', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] })
    const { result } = renderHook(() => useCountUp(200, 400))
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBeGreaterThan(0)
    expect(result.current).toBeLessThan(200)
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current).toBe(200)
  })

  it('is instant under prefers-reduced-motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const { result } = renderHook(() => useCountUp(42))
    expect(result.current).toBe(42)
  })

  // The two mid-flight tests also fake cancelAnimationFrame: with only rAF
  // faked, the cleanup's cancel is a no-op on sinon ids and the superseded
  // tick chain keeps running as a ghost, masking retarget/freeze bugs.
  it('retargets mid-flight from the live displayed value, not the old target', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { result, rerender } = renderHook(
      ({ v }: { v: number }) => useCountUp(v, 400),
      { initialProps: { v: 200 } },
    )
    act(() => { vi.advanceTimersByTime(200) })
    const mid = result.current
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(200)
    rerender({ v: 300 })
    // The first frame after the retarget must continue from ≈ the mid-flight
    // display. With the stale-target bug the new animation started from the
    // OLD target (200), visibly jumping past it on frame one.
    act(() => { vi.advanceTimersByTime(16) })
    expect(result.current).toBeGreaterThanOrEqual(mid)
    expect(result.current).toBeLessThan(200)
    act(() => { vi.advanceTimersByTime(600) })
    expect(result.current).toBe(300)
  })

  it('still reaches the target when only durMs changes mid-flight (no freeze)', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { result, rerender } = renderHook(
      ({ d }: { d: number }) => useCountUp(200, d),
      { initialProps: { d: 400 } },
    )
    act(() => { vi.advanceTimersByTime(200) })
    const mid = result.current
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(200)
    rerender({ d: 800 })
    // With the stale-target bug the cleanup seeded fromRef with the unchanged
    // target, the new effect early-returned (from === value), and the display
    // froze at `mid` forever.
    act(() => { vi.advanceTimersByTime(1200) })
    expect(result.current).toBe(200)
  })
})
