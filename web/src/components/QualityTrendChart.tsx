import { useMemo } from 'react'
import type { MetricsQualityTimeseries } from '@k/shared'
import { qualityBars, qualityBarRenderHeight, axisTickIndices } from '../lib/chart'

interface Props {
  data: MetricsQualityTimeseries
  /** Which per-day quality field to plot. */
  field: 'successRate' | 'avgLatencyMs'
  color: string
  format: (v: number) => string
  /** Pin the y-scale (pass 1 for the 0..1 success-rate axis). Omit → auto-scale to the
   *  largest sample (used for latency). */
  fixedMax?: number
  height?: number
}

function shortDate(d: string): string {
  const parts = d.split('-')
  if (parts.length !== 3) return d
  return `${parts[1]}/${parts[2]}`
}

/**
 * A compact per-day trend of a single quality series (success-rate or latency) — the
 * time-series companion to the single-KPI tiles (W9b F-087). Mirrors TimeseriesChart's
 * SVG bar layout + date axis, but for ONE non-additive series with GAP semantics: a day
 * with no terminal runs / no latency samples (value null) renders no bar, so a real gap
 * never reads as a 0% / 0ms day. The headline shows the most recent day that HAS data.
 */
export default function QualityTrendChart({ data, field, color, format, fixedMax, height = 120 }: Props) {
  const values = useMemo(() => data.points.map(p => p[field]), [data, field])
  const { bars, max } = useMemo(() => qualityBars(values, fixedMax), [values, fixedMax])
  const n = data.dates.length

  // Most recent day carrying data → the headline value (skip trailing gap days).
  const latest = useMemo(() => {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i]
      if (v != null && Number.isFinite(v)) return v
    }
    return null
  }, [values])

  const isEmpty = latest === null
  const barWidth = 7
  const viewW = Math.max(n * 10, 10)
  const axisTicks = axisTickIndices(n)

  return (
    <div>
      {/* headline current value + scale annotation */}
      <div className="mb-1 flex items-baseline justify-between">
        <span className="mono text-lg font-semibold text-[var(--text)]">
          {latest === null ? '—' : format(latest)}
        </span>
        <span className="text-[10px] font-mono text-[var(--muted)]">max {format(max)}</span>
      </div>

      {/* SVG bars */}
      <div style={{ height }} className="relative w-full">
        {isEmpty ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-[var(--muted)]">
            no data in window
          </div>
        ) : (
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${viewW} 100`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${field === 'successRate' ? 'Success rate' : 'Latency'} per day`}
            className="block"
          >
            {bars.map(b => {
              // A null day is a GAP (no bar); a REAL value — incl. a genuine 0%/0ms day —
              // gets a min-visible sliver so a total-failure day is not mistaken for a gap.
              const h = qualityBarRenderHeight(b)
              return h == null ? null : (
                <rect
                  key={b.index}
                  x={b.index * 10 + 1.5}
                  y={100 - h}
                  width={barWidth}
                  height={h}
                  fill={color}
                />
              )
            })}
          </svg>
        )}
      </div>

      {/* date axis — shares TimeseriesChart's tick logic (axisTickIndices) */}
      {n > 0 && (
        <div className="relative mt-1 h-4">
          {axisTicks.map(i => {
            const pct = n === 1 ? 0 : (i / (n - 1)) * 100
            return (
              <span
                key={i}
                className="mono absolute text-[10px] text-[var(--muted)]"
                style={{
                  left: `${pct}%`,
                  transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                }}
              >
                {shortDate(data.dates[i])}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
