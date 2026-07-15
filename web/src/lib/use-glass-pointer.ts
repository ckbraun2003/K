import { useEffect } from 'react'
import { prefersReducedMotion } from './motion'

/**
 * LG2 pointer sheen (impressive-wave W0.6 — FE-1.4). ONE window-level
 * pointermove listener, rAF-throttled, writing --lg-mx/--lg-my (viewport px)
 * on <html>; .glass-interactive's ::before anchors a radial highlight to those
 * coords via background-attachment: fixed. Mounted once, in Shell. Disabled on
 * touch (pointer: coarse) and under prefers-reduced-motion.
 */
export function useGlassPointer(): void {
  useEffect(() => {
    if (prefersReducedMotion()) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return
    let raf = 0
    let x = 0
    let y = 0
    const onMove = (e: PointerEvent) => {
      x = e.clientX
      y = e.clientY
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        document.documentElement.style.setProperty('--lg-mx', `${x}px`)
        document.documentElement.style.setProperty('--lg-my', `${y}px`)
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
}
