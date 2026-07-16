// web/src/components/BudgetBurndownChart.tsx — E-17 measured burn-down.
// Per-day MEASURED spend bars (runs.cost_usd summed by day) over the rolling window —
// NO forecasting, no price×token math. Mirrors QualityTrendChart's SVG idiom (viewBox
// "0 0 W 100" + preserveAspectRatio="none", role="img" + aria-label, chart-palette fill).
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { axisTickIndices, tooltipLeftPct } from '../lib/chart'

export default function BudgetBurndownChart({ days = 14, color = 'var(--chart-1)' }: { days?: number; color?: string }) {
  const { data } = useQuery({
    queryKey: ['budget', 'burndown', days],
    queryFn: () => api.budget.burndown(days),
    refetchInterval: 30_000,
  })
  const [hover, setHover] = useState<number | null>(null)
  const buckets = data?.buckets ?? []
  const n = buckets.length
  const max = Math.max(1, ...buckets.map(b => b.costUsd))
  const ticks = axisTickIndices(n)
  return (
    <div data-testid="budget-burndown">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="mono tabular-nums text-body font-semibold text-text">
          ${(data?.totalCostUsd ?? 0).toFixed(2)}
          <span className="micro-label ml-1.5 opacity-70">measured spend · {days}d</span>
        </span>
      </div>
      {n === 0 ? (
        <div className="text-caption text-muted">No spend in window.</div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${n * 10} 100`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Measured daily spend"
            className="block h-24 w-full"
            onMouseLeave={() => setHover(null)}
          >
            {[25, 50, 75].map(y => (
              <line key={y} x1={0} y1={y} x2={n * 10} y2={y} stroke="var(--border)" strokeOpacity={0.4} vectorEffect="non-scaling-stroke" />
            ))}
            {buckets.map((b, i) => {
              const h = (b.costUsd / max) * 100
              return <rect key={b.key} x={i * 10 + 1} y={100 - h} width={8} height={h} fill={color} />
            })}
            {buckets.map((_, i) => (
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
              <div className="mono text-micro text-muted">{buckets[hover].label}</div>
              <div className="mono tabular-nums text-caption text-text">
                ${buckets[hover].costUsd.toFixed(2)} ({buckets[hover].runs} runs)
              </div>
            </div>
          )}
          <div className="relative mt-1 h-4">
            {ticks.map(i => (
              <span key={i} className="mono absolute text-micro text-muted"
                style={{ left: `${n === 1 ? 0 : (i / (n - 1)) * 100}%`, transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                {buckets[i].key.slice(5).replace('-', '/')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
