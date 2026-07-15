import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './motion'

/**
 * Count-up numerals (impressive-wave W0.7 — FE-2). Interpolates the returned
 * number toward `value` with rAF (easeOutCubic): 0 → value on first mount,
 * previous → next on refetch. Instant under prefers-reduced-motion. Consumers
 * format the raw number themselves (KpiTile keeps mono + tabular-nums).
 */
export function useCountUp(value: number, durMs = 600): number {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0))
  const fromRef = useRef(prefersReducedMotion() ? value : 0)
  useEffect(() => {
    if (prefersReducedMotion() || durMs <= 0) {
      fromRef.current = value
      setDisplay(value)
      return
    }
    const from = fromRef.current
    if (from === value) return
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durMs)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + (value - from) * eased)
      if (p < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        fromRef.current = value
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      fromRef.current = value
    }
  }, [value, durMs])
  return display
}
