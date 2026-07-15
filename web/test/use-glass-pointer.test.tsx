import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGlassPointer } from '../src/lib/use-glass-pointer'

function pointerMove(x: number, y: number) {
  // jsdom has no PointerEvent constructor — a plain Event with client coords
  // assigned as own props exercises the listener identically.
  const ev = new Event('pointermove')
  Object.assign(ev, { clientX: x, clientY: y })
  window.dispatchEvent(ev)
}

describe('useGlassPointer', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { matchMedia?: unknown }).matchMedia
    document.documentElement.style.removeProperty('--lg-mx')
    document.documentElement.style.removeProperty('--lg-my')
  })

  it('writes --lg-mx/--lg-my on <html> after the rAF flush', () => {
    const { unmount } = renderHook(() => useGlassPointer())
    pointerMove(120, 84)
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('120px')
    expect(document.documentElement.style.getPropertyValue('--lg-my')).toBe('84px')
    unmount()
    pointerMove(300, 200) // listener removed on unmount
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('120px')
  })

  it('no-ops under prefers-reduced-motion / coarse pointers', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    renderHook(() => useGlassPointer())
    pointerMove(50, 50)
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('')
  })
})
