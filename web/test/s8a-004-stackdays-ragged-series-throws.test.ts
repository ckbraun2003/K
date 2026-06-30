/**
 * REGRESSION — FAULT S8-004 (FIXED + promoted to gating, reboot wave F1.W3).
 * Finding: testing/findings/S8-web-ui.md → row S8-004.
 *
 * Surface: web/src/lib/chart.ts :: stackDays
 *   (`series.reduce((sum, s) => sum + s.points[di][metric], 0)`, line 24, and the
 *    same indexing in the segment loop, line 33).
 *
 * Expected: per the S8 charter, chart helpers tolerate weird/partial input and
 *   "degrade defensibly" — a series whose `points` array is shorter than `dates`
 *   (or empty) should contribute 0 for the missing days, not crash the chart.
 * Was: `s.points[di]` is `undefined` past the points length, so
 *   `undefined[metric]` threw `TypeError: Cannot read properties of undefined
 *   (reading 'tokens')`, taking down the whole metrics view.
 *
 * FIXED: both lookups now guard with `s.points[di]?.[metric] ?? 0`, so a missing
 * day contributes 0 and the chart degrades instead of throwing. This test asserts
 * that EXPECTED (safe) behavior → now GREEN and gates.
 *
 * prober: PROBER-A · validator: VALIDATOR-A
 */
import { describe, it, expect } from 'vitest'
import { stackDays } from '../src/lib/chart'
import type { MetricsTimeseries } from '@k/shared'

// dates has 3 entries but the series only carries ONE point (ragged payload).
function raggedData(pointsLen: number): MetricsTimeseries {
  const point = { runs: 1, tokens: 100, costUsd: 0.5 }
  return {
    groupBy: 'project',
    days: 3,
    dates: ['2024-01-01', '2024-01-02', '2024-01-03'],
    series: [
      {
        key: 'a',
        label: 'a',
        points: Array.from({ length: pointsLen }, () => ({ ...point })),
        total: { runs: pointsLen, tokens: 100 * pointsLen, costUsd: 0.5 * pointsLen },
      },
    ],
  }
}

describe('S8-004 — stackDays must not throw on ragged/short series points', () => {
  it('a series with fewer points than dates degrades (missing day = 0)', () => {
    const data = raggedData(1)
    expect(() => stackDays(data, 'tokens')).not.toThrow()
    const { days } = stackDays(data, 'tokens')
    expect(days).toHaveLength(3)
    // Day 0 has the single real point; days 1 & 2 are missing -> treated as 0.
    expect(days[0].total).toBe(100)
    expect(days[1].total).toBe(0)
    expect(days[2].segments).toEqual([])
  })

  it('a series with an empty points array degrades to all-zero days', () => {
    const data = raggedData(0)
    expect(() => stackDays(data, 'runs')).not.toThrow()
    const { maxTotal, days } = stackDays(data, 'runs')
    expect(maxTotal).toBe(1) // floor
    expect(days.every(d => d.total === 0)).toBe(true)
  })
})
