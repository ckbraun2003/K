import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/** E-18 retry-rate — a compact per-day bar chart of runs.retry_of measured off the
 *  /api/metrics/retry-rate endpoint. Headline = overall rate; bars = per-day rate.
 *  Mirrors QualityTrendChart's SVG bar layout (chart-var fill, role="img"). */
export default function RetryRateChart({ days = 14, color = 'var(--chart-1)' }: { days?: number; color?: string }) {
  const { data } = useQuery({ queryKey: ['retry-rate', days], queryFn: () => api.retryMetrics.series(days), refetchInterval: 30_000 })
  const pts = data?.points ?? []
  return (
    <div data-testid="retry-rate">
      <div className="mb-1 text-sm font-semibold text-[var(--text)]">{((data?.overallRate ?? 0) * 100).toFixed(0)}%</div>
      {pts.length === 0 ? <div className="text-sm text-[var(--muted)]">No retries in window.</div> : (
        <svg viewBox={`0 0 ${pts.length * 10} 100`} preserveAspectRatio="none" role="img" aria-label="Retry rate per day" className="block h-24 w-full">
          {pts.map((p, i) => (
            <rect key={p.day} x={i * 10 + 1} y={100 - p.rate * 100} width={8} height={p.rate * 100} fill={color}>
              <title>{`${p.day}: ${(p.rate * 100).toFixed(0)}% (${p.retries}/${p.runs})`}</title>
            </rect>
          ))}
        </svg>
      )}
    </div>
  )
}
