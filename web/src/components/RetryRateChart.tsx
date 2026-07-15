import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { axisTickIndices, tooltipLeftPct } from '../lib/chart'

/** E-18 retry-rate — per-day retry share with the shared hover layer (FE-4 #5).
 *  A measured 0% day draws a minimum-visible baseline sliver (matching the
 *  QualityTrendChart real-zero convention) so "no self-correction needed"
 *  never reads as "no data". */
export default function RetryRateChart({ days = 14, color = 'var(--chart-1)' }: { days?: number; color?: string }) {
  const { data } = useQuery({ queryKey: ['retry-rate', days], queryFn: () => api.retryMetrics.series(days), refetchInterval: 30_000 })
  const [hover, setHover] = useState<number | null>(null)
  const pts = data?.points ?? []
  const n = pts.length
  const ticks = axisTickIndices(n)
  return (
    <div data-testid="retry-rate">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="mono tabular-nums text-body font-semibold text-text">
          {((data?.overallRate ?? 0) * 100).toFixed(0)}%
          <span className="micro-label ml-1.5 opacity-70">retry rate · {days}d</span>
        </span>
        <span className="mono text-micro text-muted">max 100%</span>
      </div>
      {n === 0 ? (
        <div className="text-caption text-muted">No runs in window.</div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none" role="img" aria-label="Retry rate per day"
            className="block h-24 w-full" onMouseLeave={() => setHover(null)}>
            {[25, 50, 75].map(y => (
              <line key={y} x1={0} y1={y} x2={n * 10} y2={y} stroke="var(--border)" strokeOpacity={0.4} vectorEffect="non-scaling-stroke" />
            ))}
            {pts.map((p, i) => {
              const h = Math.max(1, p.rate * 100) // real 0% → 1-unit baseline sliver
              return <rect key={p.day} x={i * 10 + 1} y={100 - h} width={8} height={h} fill={color} />
            })}
            {pts.map((_, i) => (
              <rect key={`ov-${i}`} x={i * 10} y={0} width={10} height={100}
                fill={hover === i ? 'rgba(255,255,255,0.04)' : 'transparent'}
                onMouseEnter={() => setHover(i)} style={{ cursor: 'crosshair' }} />
            ))}
            {hover !== null && (
              <line x1={hover * 10 + 5} y1={0} x2={hover * 10 + 5} y2={100} stroke="var(--border-strong)" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hover !== null && (
            <div className="glass-overlay pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-control px-2 py-1"
              style={{ left: `${tooltipLeftPct(hover, n)}%` }}>
              <div className="mono text-micro text-muted">{pts[hover].day}</div>
              <div className="mono tabular-nums text-caption text-text">
                {(pts[hover].rate * 100).toFixed(0)}% · {pts[hover].retries}/{pts[hover].runs} runs
              </div>
            </div>
          )}
          <div className="relative mt-1 h-4">
            {ticks.map(i => (
              <span key={i} className="mono absolute text-micro text-muted"
                style={{ left: `${n === 1 ? 0 : (i / (n - 1)) * 100}%`, transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                {pts[i].day.slice(5).replace('-', '/')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
