import { useMemo, useState } from 'react'
import type { MetricsTimeseries } from '@k/shared'
import { stackDays, formatMetricValue, metricLabel, axisTickIndices, tooltipLeftPct as clampTooltipLeftPct, type Metric } from '../lib/chart'
import { EmptyState } from '../ui/EmptyState'

// Recessive gridlines drawn behind the bars (SVG y is top-down; 20/40/60/80 = 80/60/40/20% of maxTotal).
const GRIDLINE_YS = [20, 40, 60, 80]

interface Props {
  data: MetricsTimeseries
  metric: Metric
  height?: number
}

function seriesFill(key: string, seriesIndex: number): string {
  if (key === 'other') return 'var(--chart-other)'
  const n = (seriesIndex % 8) + 1
  return `var(--chart-${n})`
}

function shortDate(d: string): string {
  // d = YYYY-MM-DD
  const parts = d.split('-')
  if (parts.length !== 3) return d
  return `${parts[1]}/${parts[2]}`
}

export default function TimeseriesChart({ data, metric, height = 180 }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  // Memoized so hover state changes don't re-walk every series×date.
  const { days, maxTotal } = useMemo(() => stackDays(data, metric), [data, metric])
  const n = data.dates.length

  // Empty state: all zeros
  const isEmpty = data.series.length === 0 || data.dates.length === 0 ||
    days.every(d => d.total === 0)

  const barWidth = 7 // bar slot is 10 wide: x = i*10 + 1.5 centers a 7px bar
  const viewW = Math.max(n * 10, 10)

  // Date axis ticks: first, every ~7th, last — see axisTickIndices (finding #22).
  const axisTicks = axisTickIndices(n)

  // Detail row content — memoized; only changes when data/metric/hover change.
  const hovered = hoverIndex !== null
  const detailSeries = useMemo(() => data.series.filter(s => {
    if (hoverIndex !== null) return s.points[hoverIndex][metric] !== 0
    return s.total[metric] !== 0
  }), [data, metric, hoverIndex])

  // Clamped percentage-left position for the floating hover tooltip, so it never
  // overflows the chart's left/right edge (shared across every hover-enabled chart).
  const tooltipLeftPct = hoverIndex !== null ? clampTooltipLeftPct(hoverIndex, n) : 0

  return (
    <div>
      {/* max-value annotation */}
      <div className="mb-1 mono text-micro text-muted">
        max {formatMetricValue(metric, maxTotal)}
      </div>

      {/* SVG chart */}
      <div style={{ height }} className="relative w-full">
        {isEmpty ? (
          <div className="flex h-full w-full items-center justify-center">
            <EmptyState icon="insights" headline="No runs in this window" />
          </div>
        ) : (
          <>
            <svg
              width="100%"
              height={height}
              viewBox={`0 0 ${viewW} 100`}
              preserveAspectRatio="none"
              onMouseLeave={() => setHoverIndex(null)}
              role="img"
              aria-label={`${metricLabel(metric)} per day, stacked by ${data.groupBy}`}
              className="block"
            >
              {/* recessive gridlines — drawn behind the bars */}
              {GRIDLINE_YS.map(y => (
                <line
                  key={y}
                  x1={0} y1={y} x2={viewW} y2={y}
                  stroke="var(--border)"
                  strokeOpacity={0.4}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {/* stacked bars */}
              {days.map((day, di) => (
                day.segments.map(seg => {
                  const svgY0 = 100 - seg.y1   // SVG y is top-down; y1 is top of bar
                  const svgY1 = 100 - seg.y0   // y0 is bottom of bar
                  const rectH = svgY1 - svgY0
                  if (rectH <= 0) return null
                  return (
                    <rect
                      key={`${di}-${seg.key}`}
                      x={di * 10 + 1.5}
                      y={svgY0}
                      width={barWidth}
                      height={rectH}
                      fill={seriesFill(seg.key, seg.seriesIndex)}
                    />
                  )
                })
              ))}

              {/* hover overlay rects */}
              {n > 0 && Array.from({ length: n }, (_, di) => (
                <rect
                  key={`overlay-${di}`}
                  x={di * 10 + 1.5}
                  y={0}
                  width={barWidth}
                  height={100}
                  fill={hoverIndex === di ? 'rgba(255,255,255,0.04)' : 'transparent'}
                  onMouseEnter={() => setHoverIndex(di)}
                  style={{ cursor: 'crosshair' }}
                />
              ))}

              {/* hover crosshair */}
              {hoverIndex !== null && (
                <line
                  x1={hoverIndex * 10 + 5} y1={0}
                  x2={hoverIndex * 10 + 5} y2={100}
                  stroke="var(--border-strong)"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            {/* floating hover tooltip */}
            {hoverIndex !== null && (
              <div
                className="glass-overlay pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-control px-2 py-1.5"
                style={{ left: `${tooltipLeftPct}%` }}
              >
                <div className="mono text-micro text-muted">{data.dates[hoverIndex]}</div>
                {detailSeries.map(s => {
                  const origIdx = data.series.indexOf(s)
                  const val = s.points[hoverIndex][metric]
                  return (
                    <div key={s.key} className="mt-0.5 flex items-center gap-1.5">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
                        style={{ background: seriesFill(s.key, origIdx) }}
                      />
                      <span className="text-caption text-muted truncate max-w-[100px]">{s.label}</span>
                      <span className="mono tabular-nums text-caption text-text">
                        {formatMetricValue(metric, val)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Date axis */}
      {n > 0 && (
        <div className="relative mt-1 h-4">
          {axisTicks.map(i => {
            const pct = n === 1 ? 0 : (i / (n - 1)) * 100
            return (
              <span
                key={i}
                className="mono absolute text-micro text-muted"
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

      {/* Detail / legend row — fixed height to avoid layout jump. A bare value for 0-1 series;
          swatch + label + value (a proper legend key) once ≥2 series are present. */}
      <div className="mt-3 min-h-[4.5rem] border-t border-border pt-2">
        {hovered && hoverIndex !== null && (
          <div className="mb-1 mono text-micro text-muted">
            {data.dates[hoverIndex]}
          </div>
        )}
        {detailSeries.length === 0 ? (
          <span className="text-micro text-muted">—</span>
        ) : detailSeries.length === 1 ? (
          <span className="mono tabular-nums text-caption text-text">
            {formatMetricValue(metric, hovered && hoverIndex !== null ? detailSeries[0].points[hoverIndex][metric] : detailSeries[0].total[metric])}
          </span>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {detailSeries.map((s) => {
              // find original series index for color
              const origIdx = data.series.indexOf(s)
              const val = hovered && hoverIndex !== null
                ? s.points[hoverIndex][metric]
                : s.total[metric]
              return (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                    style={{ background: seriesFill(s.key, origIdx) }}
                  />
                  <span className="text-caption text-muted truncate max-w-[120px]">{s.label}</span>
                  <span className="mono tabular-nums text-caption text-text">
                    {formatMetricValue(metric, val)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
