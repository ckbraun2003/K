import { describe, it, expect } from 'vitest'
import { stackDays, formatMetricValue, metricLabel, axisTickIndices } from '../src/lib/chart'
import type { MetricsTimeseries } from '@k/shared'

function makeData(seriesPoints: { key: string; vals: { runs: number; tokens: number; costUsd: number }[] }[]): MetricsTimeseries {
  const dates = seriesPoints[0]?.vals.map((_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`) ?? []
  return {
    groupBy: 'project',
    days: dates.length,
    dates,
    series: seriesPoints.map(s => ({
      key: s.key,
      label: s.key,
      points: s.vals,
      total: s.vals.reduce(
        (acc, p) => ({ runs: acc.runs + p.runs, tokens: acc.tokens + p.tokens, costUsd: acc.costUsd + p.costUsd }),
        { runs: 0, tokens: 0, costUsd: 0 }
      ),
    })),
  }
}

describe('stackDays', () => {
  it('stacks two series correctly', () => {
    const data = makeData([
      { key: 'a', vals: [{ runs: 1, tokens: 100, costUsd: 0 }] },
      { key: 'b', vals: [{ runs: 2, tokens: 200, costUsd: 0 }] },
    ])
    const { days, maxTotal } = stackDays(data, 'tokens')
    expect(maxTotal).toBe(300)
    expect(days).toHaveLength(1)
    const segs = days[0].segments
    expect(segs).toHaveLength(2)
    // series a: y0=0, y1=(100/300)*100 ~33.33
    expect(segs[0].key).toBe('a')
    expect(segs[0].y0).toBeCloseTo(0)
    expect(segs[0].y1).toBeCloseTo(33.333, 2)
    // series b: y0=33.33, y1=100
    expect(segs[1].key).toBe('b')
    expect(segs[1].y0).toBeCloseTo(33.333, 2)
    expect(segs[1].y1).toBeCloseTo(100)
  })

  it('skips zero-value rects', () => {
    const data = makeData([
      { key: 'a', vals: [{ runs: 0, tokens: 0, costUsd: 0 }, { runs: 5, tokens: 500, costUsd: 0 }] },
      { key: 'b', vals: [{ runs: 1, tokens: 100, costUsd: 0 }, { runs: 0, tokens: 0, costUsd: 0 }] },
    ])
    const { days } = stackDays(data, 'tokens')
    // day 0: a=0 (skipped), b=100 → 1 segment
    expect(days[0].segments).toHaveLength(1)
    expect(days[0].segments[0].key).toBe('b')
    // day 1: a=500, b=0 (skipped) → 1 segment
    expect(days[1].segments).toHaveLength(1)
    expect(days[1].segments[0].key).toBe('a')
  })

  it('maxTotal is at least 1 even for all-zero data', () => {
    const data = makeData([
      { key: 'a', vals: [{ runs: 0, tokens: 0, costUsd: 0 }] },
    ])
    const { maxTotal } = stackDays(data, 'tokens')
    expect(maxTotal).toBe(1)
  })

  it('handles empty series array', () => {
    const data: MetricsTimeseries = { groupBy: 'project', days: 2, dates: ['2024-01-01', '2024-01-02'], series: [] }
    const { days, maxTotal } = stackDays(data, 'tokens')
    expect(maxTotal).toBe(1)
    expect(days).toHaveLength(2)
    expect(days[0].segments).toHaveLength(0)
  })

  it('uses correct metric field', () => {
    const data = makeData([
      { key: 'a', vals: [{ runs: 5, tokens: 100, costUsd: 2.5 }] },
    ])
    const runs = stackDays(data, 'runs')
    expect(runs.maxTotal).toBe(5)

    const cost = stackDays(data, 'costUsd')
    expect(cost.maxTotal).toBe(2.5)
  })
})

describe('formatMetricValue', () => {
  it('formats tokens: below 1000 as integer', () => {
    expect(formatMetricValue('tokens', 999)).toBe('999')
    expect(formatMetricValue('tokens', 0)).toBe('0')
    expect(formatMetricValue('tokens', 1)).toBe('1')
  })

  it('formats tokens: 1000 → 1.0k', () => {
    expect(formatMetricValue('tokens', 1000)).toBe('1.0k')
  })

  it('formats tokens: 1_250_000 → 1.3M', () => {
    expect(formatMetricValue('tokens', 1_250_000)).toBe('1.3M')
  })

  it('formats tokens: 1_200_000 → 1.2M', () => {
    expect(formatMetricValue('tokens', 1_200_000)).toBe('1.2M')
  })

  it('formats costUsd under $1 with 4dp', () => {
    expect(formatMetricValue('costUsd', 0.5)).toBe('$0.5000')
    expect(formatMetricValue('costUsd', 0)).toBe('$0.0000')
    expect(formatMetricValue('costUsd', 0.9999)).toBe('$0.9999')
  })

  it('formats costUsd at/above $1 with 2dp', () => {
    expect(formatMetricValue('costUsd', 1.5)).toBe('$1.50')
    expect(formatMetricValue('costUsd', 10)).toBe('$10.00')
  })

  it('formats runs as integer', () => {
    expect(formatMetricValue('runs', 0)).toBe('0')
    expect(formatMetricValue('runs', 42)).toBe('42')
    expect(formatMetricValue('runs', 1_000_000)).toBe('1000000')
  })

  it('renders an em-dash for non-finite values', () => {
    expect(formatMetricValue('tokens', NaN)).toBe('—')
    expect(formatMetricValue('costUsd', Infinity)).toBe('—')
    expect(formatMetricValue('runs', -Infinity)).toBe('—')
  })
})

describe('metricLabel', () => {
  it('maps raw metric fields to human-readable labels (no "costUsd" leaking to a11y)', () => {
    expect(metricLabel('tokens')).toBe('Tokens')
    expect(metricLabel('costUsd')).toBe('Cost')
    expect(metricLabel('runs')).toBe('Runs')
  })
})

describe('axisTickIndices', () => {
  it('returns nothing for an empty window', () => {
    expect(axisTickIndices(0)).toEqual([])
  })

  it('single column shows only index 0', () => {
    expect(axisTickIndices(1)).toEqual([0])
  })

  it('7d window: first + last, no crowding', () => {
    expect(axisTickIndices(7)).toEqual([0, 6])
  })

  it('14d window: first, weekly, last', () => {
    expect(axisTickIndices(14)).toEqual([0, 7, 13])
  })

  it('30d window: drops the index-28 weekly tick that collides with the final index-29 tick (finding #22)', () => {
    // Without the gap rule this was [0,7,14,21,28,29] — 28 and 29 overprint.
    expect(axisTickIndices(30)).toEqual([0, 7, 14, 21, 29])
  })

  it('60d window: drops the index-56 tick that sits exactly 3 slots from the final index', () => {
    // `<= 3` gap rule widens the previously-tight 56↔59 gap (finding follow-up).
    expect(axisTickIndices(60)).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 59])
  })

  it('always ends with the final index and never duplicates it', () => {
    for (const n of [2, 5, 8, 9, 10, 15, 21, 28, 30, 31, 60]) {
      const t = axisTickIndices(n)
      expect(t[t.length - 1]).toBe(n - 1)
      expect(new Set(t).size).toBe(t.length)
      // strictly increasing
      for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1])
    }
  })
})
