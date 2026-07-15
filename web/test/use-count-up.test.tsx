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
})
