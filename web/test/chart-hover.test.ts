/** FE-4 systemic #5 — shared clamped tooltip-position math, extracted from
 *  TimeseriesChart so every hover-enabled chart (Retry, Budget, Quality) shares
 *  ONE positioning rule instead of re-deriving it inline. */
import { describe, it, expect } from 'vitest'
import { tooltipLeftPct } from '../src/lib/chart'

describe('tooltipLeftPct', () => {
  it('centers on the hovered column, clamped to 8..92%', () => {
    expect(tooltipLeftPct(0, 30)).toBeCloseTo(8)     // clamped left
    expect(tooltipLeftPct(29, 30)).toBeCloseTo(92)   // clamped right
    expect(tooltipLeftPct(7, 15)).toBeCloseTo(50)
    expect(tooltipLeftPct(0, 1)).toBe(50)            // single column centers
  })
})
