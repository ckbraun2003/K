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

// Queued rAF mock: callbacks run only when flushRaf() is called, matching real
// browser ordering (requestAnimationFrame returns its id BEFORE the callback
// fires, so the hook's `raf` guard is set while the frame is pending).
let rafQueue: FrameRequestCallback[] = []
function flushRaf() {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb(0)
}

describe('useGlassPointer', () => {
  beforeEach(() => {
    rafQueue = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { rafQueue = [] })
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
    // Frame not flushed yet — vars still unset (rAF throttling is real).
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('')
    flushRaf()
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('120px')
    expect(document.documentElement.style.getPropertyValue('--lg-my')).toBe('84px')
    unmount()
    pointerMove(300, 200) // listener removed on unmount
    flushRaf()
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('120px')
  })

  it('no-ops under prefers-reduced-motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    renderHook(() => useGlassPointer())
    pointerMove(50, 50)
    flushRaf()
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('')
  })

  it('no-ops on coarse pointers even when reduced-motion is off', () => {
    // Query-sensitive mock: motion allowed, pointer coarse — exercises the
    // (pointer: coarse) guard independently of prefersReducedMotion().
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)',
    })) as never
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useGlassPointer())
    expect(addSpy.mock.calls.some(c => c[0] === 'pointermove')).toBe(false)
    pointerMove(50, 50)
    flushRaf()
    expect(document.documentElement.style.getPropertyValue('--lg-mx')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--lg-my')).toBe('')
  })
})
