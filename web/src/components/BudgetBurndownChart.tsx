// web/src/components/BudgetBurndownChart.tsx — E-17 measured burn-down.
// Per-day MEASURED spend bars (runs.cost_usd summed by day) over the rolling window —
// NO forecasting, no price×token math. Mirrors QualityTrendChart's SVG idiom (viewBox
// "0 0 W 100" + preserveAspectRatio="none", role="img" + aria-label, chart-palette fill).
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

export default function BudgetBurndownChart({ days = 14, color = 'var(--chart-1)' }: { days?: number; color?: string }) {
  const { data } = useQuery({
    queryKey: ['budget', 'burndown', days],
    queryFn: () => api.budget.burndown(days),
    refetchInterval: 30_000,
  })
  const buckets = data?.buckets ?? []
  const max = Math.max(1, ...buckets.map(b => b.costUsd))
  return (
    <div data-testid="budget-burndown">
      <div className="mb-1 text-sm font-semibold text-[var(--text)]">${(data?.totalCostUsd ?? 0).toFixed(2)}</div>
      {buckets.length === 0 ? (
        <div className="text-sm text-[var(--muted)]">No spend in window.</div>
      ) : (
        <svg
          viewBox={`0 0 ${buckets.length * 10} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Measured daily spend"
          className="block h-24 w-full"
        >
          {buckets.map((b, i) => (
            <rect
              key={b.key}
              x={i * 10 + 1}
              y={100 - (b.costUsd / max) * 100}
              width={8}
              height={(b.costUsd / max) * 100}
              fill={color}
            >
              <title>{`${b.label}: $${b.costUsd.toFixed(2)} (${b.runs} runs)`}</title>
            </rect>
          ))}
        </svg>
      )}
    </div>
  )
}
