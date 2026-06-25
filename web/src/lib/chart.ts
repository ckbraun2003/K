import type { MetricsTimeseries } from '@k/shared'

export type Metric = 'tokens' | 'costUsd' | 'runs'

export interface StackSegment {
  seriesIndex: number
  key: string
  y0: number  // 0..100 (percentage of maxTotal)
  y1: number
}

export interface StackDay {
  dateIndex: number
  segments: StackSegment[]
  total: number
}

/** Returns per-day stacked segments (y in 0..100 scale) + maxTotal (>= 1). */
export function stackDays(data: MetricsTimeseries, metric: Metric): { days: StackDay[]; maxTotal: number } {
  const { series, dates } = data

  // compute per-day totals
  const dayTotals = dates.map((_, di) =>
    series.reduce((sum, s) => sum + s.points[di][metric], 0)
  )
  const maxTotal = Math.max(...dayTotals, 1)

  const days: StackDay[] = dates.map((_, di) => {
    let cursor = 0
    const segments: StackSegment[] = []
    for (let si = 0; si < series.length; si++) {
      const v = series[si].points[di][metric]
      if (v === 0) continue
      const y0pct = (cursor / maxTotal) * 100
      cursor += v
      const y1pct = (cursor / maxTotal) * 100
      segments.push({ seriesIndex: si, key: series[si].key, y0: y0pct, y1: y1pct })
    }
    return { dateIndex: di, segments, total: dayTotals[di] }
  })

  return { days, maxTotal }
}

/**
 * Date-axis tick indices for `n` columns: first, every ~7th, last — but any
 * weekly tick within 3 slots of the final index (inclusive) is dropped so the
 * right-aligned last label (translateX(-100%)) doesn't overprint the preceding
 * -50%-anchored tick (finding #22: the 30d window collided at index 28 vs 29).
 * `<= 3` also widens the exactly-3 gap at n=60 without altering 7/14/30d.
 */
export function axisTickIndices(n: number): number[] {
  if (n <= 0) return []
  const ticks = [0]
  for (let i = 7; i < n - 1; i += 7) {
    if (n > 1 && n - 1 - i <= 3) break
    ticks.push(i)
  }
  if (n > 1) ticks.push(n - 1)
  return ticks
}

/** Format a metric value for display. */
export function formatMetricValue(metric: Metric, v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (metric === 'runs') return String(Math.round(v))
  if (metric === 'costUsd') {
    if (v < 1) return `$${v.toFixed(4)}`
    return `$${v.toFixed(2)}`
  }
  // tokens
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(Math.round(v))
}
