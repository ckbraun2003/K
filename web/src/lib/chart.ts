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
    series.reduce((sum, s) => sum + (s.points[di]?.[metric] ?? 0), 0)
  )
  const maxTotal = Math.max(...dayTotals, 1)

  const days: StackDay[] = dates.map((_, di) => {
    let cursor = 0
    const segments: StackSegment[] = []
    for (let si = 0; si < series.length; si++) {
      const v = series[si].points[di]?.[metric] ?? 0
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

/** Human-readable label for a metric — for chart titles, a11y aria-labels, etc.
 *  Keeps the raw field name ('costUsd') out of user-facing / screen-reader text
 *  (F-083: "costUsd per day" → "Cost per day"). */
export function metricLabel(metric: Metric): string {
  if (metric === 'costUsd') return 'Cost'
  if (metric === 'runs') return 'Runs'
  return 'Tokens'
}

// ─── Quality trend (success-rate / latency over time — W9b) ──────────────────

export interface QualityBar {
  index: number          // day index (aligns with dates[])
  value: number | null   // null = a gap day (no terminal runs / no latency samples)
  heightPct: number      // 0..100 (% of the y-scale max); 0 for a null/non-finite day
}

/**
 * Per-day bar geometry for a single quality series (success-rate or latency). A null
 * `values[i]` is a genuine GAP (no data that day) → no bar (heightPct 0), never a
 * misleading zero-height-that-looks-like-0%. `fixedMax` pins the y-scale (pass 1 for a
 * 0..1 rate so 90% always reads as 90% of the axis); omit it for latency to auto-scale
 * to the largest sample. Returns the resolved `max` (≥1, never 0 → no divide-by-zero).
 */
export function qualityBars(values: (number | null)[], fixedMax?: number): { bars: QualityBar[]; max: number } {
  let max = fixedMax ?? 0
  if (fixedMax === undefined) {
    for (const v of values) if (v != null && Number.isFinite(v) && v > max) max = v
  }
  const safeMax = max > 0 ? max : 1
  const bars = values.map((v, index) => ({
    index,
    value: v,
    heightPct: v != null && Number.isFinite(v) ? Math.min(100, Math.max(0, (v / safeMax) * 100)) : 0,
  }))
  return { bars, max: safeMax }
}

/**
 * Render height (SVG units, 0..100) for one quality bar, or null when the day is a GAP
 * (value null → draw nothing). Any REAL value — including a genuine 0% / 0ms day (e.g.
 * 3/3 errored) — gets a minimum-visible sliver (≥1) so a total-failure day is
 * DISTINGUISHABLE from a no-data gap. Without this floor a real 0 and a gap both render
 * height 0 → the mirror image of the null-vs-0 bug this feature exists to prevent (W9b).
 */
export function qualityBarRenderHeight(bar: { value: number | null; heightPct: number }): number | null {
  if (bar.value == null || !Number.isFinite(bar.value)) return null // a gap — no bar
  return Math.max(1, bar.heightPct)
}

/** Clamped %-left for a floating chart tooltip over column i of n (extracted
 *  from TimeseriesChart so every chart shares ONE positioning rule). */
export function tooltipLeftPct(i: number, n: number): number {
  return Math.min(92, Math.max(8, n === 1 ? 50 : ((i + 0.5) / n) * 100))
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
