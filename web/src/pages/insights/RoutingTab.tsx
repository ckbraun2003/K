import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsTimeseries, RoutingStats } from '@k/shared'
import { api } from '../../lib/api'
import TimeseriesChart from '../../components/TimeseriesChart'
import { GlassPanel } from '../../ui/GlassPanel'
import { Skeleton } from '../../ui/Skeleton'
import { EmptyState } from '../../ui/EmptyState'

type Days = 14 | 30 | 60

// ─── Pure format helpers (unit-tested in web/test/routing.test.ts) ───────────

/** Avg latency → '1.2s' / '840ms'. Negative/non-finite → '—'. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Success rate (0..1) → '92%'. Non-finite → '—'. */
export function formatSuccessRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

/** Cost → '$0.0123' / '$0' / '$1.50'. Non-finite → '—'. Used for the Avg-$ column,
 *  where sub-cent per-run averages need 4dp precision. */
export function formatCost(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  if (v < 1) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

/** Total-cost column formatter: ALWAYS 2 decimals so values align down the column
 *  ($0.26 beside $2.55 beside $0.00) instead of formatCost's mixed 4dp/2dp/'$0'
 *  precision (F-083). Non-finite → '—'. Totals are aggregates where 2dp reads clean;
 *  Avg-$ keeps formatCost's sub-cent precision. */
export function formatCostTotal(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return `$${v.toFixed(2)}`
}

/**
 * P4 E-10 Routing tab (extracted verbatim from the former RoutingPage). The time window is
 * now a SHARED prop from the Insights shell (was a page-local default of 30d — the window is
 * unified across Overview/Charts/Routing). Preserves the recommendation banner, the per-model
 * table, and the cost-trend-by-model chart.
 */
export default function RoutingTab({ days }: { days: Days }) {
  const { data, isLoading, error } = useQuery<RoutingStats>({
    queryKey: ['routing', days],
    queryFn: () => api.metrics.routing(days),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  const { data: trend } = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, 'model'],
    queryFn: () => api.metrics.timeseries(days, 'model'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  const groups = data?.groups ?? []

  return (
    <>
      {isLoading && !data && (
        <Skeleton className="h-[180px] w-full rounded-control" />
      )}
      {error && (
        <div className="flex h-[180px] items-center justify-center text-caption text-red">
          {String((error as Error).message ?? error)}
        </div>
      )}

      {data && (
        <>
          {/* recommendation banner */}
          <GlassPanel className="mb-4 p-4">
            <div className="micro-label mb-1">
              Recommendation
            </div>
            <p className="text-body text-text">{data.recommendation}</p>
          </GlassPanel>

          {groups.length === 0 ? (
            <EmptyState icon="insights" headline="No run history yet" hint="Routing insights appear once runs complete." />
          ) : (
            <>
              {/* per-model table */}
              <GlassPanel tier="solid" className="mb-4 overflow-hidden">
                <table className="w-full text-caption">
                  <thead>
                    <tr className="micro-label border-b border-border [&>th]:font-medium">
                      <th className="px-3 py-2 text-left">Provider</th>
                      <th className="px-3 py-2 text-left">Model</th>
                      <th className="px-3 py-2 text-right">Runs</th>
                      <th className="px-3 py-2 text-right">Success</th>
                      <th className="px-3 py-2 text-right">Avg $</th>
                      <th className="px-3 py-2 text-right">Total $</th>
                      <th className="px-3 py-2 text-right">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody className="mono tabular-nums">
                    {groups.map(g => (
                      <tr key={`${g.provider} ${g.model}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-left font-sans text-text">{g.provider}</td>
                        <td className="px-3 py-2 text-left font-sans text-muted">{g.model}</td>
                        <td className="px-3 py-2 text-right text-text">{g.runs}</td>
                        <td className="px-3 py-2 text-right text-text">{formatSuccessRate(g.successRate)}</td>
                        <td className="px-3 py-2 text-right text-muted">{formatCost(g.avgCostUsd)}</td>
                        <td className="px-3 py-2 text-right text-text">{formatCostTotal(g.totalCostUsd)}</td>
                        <td className="px-3 py-2 text-right text-muted">{formatLatency(g.avgLatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassPanel>

              {/* trend chart (cost per model) */}
              <GlassPanel tier="solid" className="p-4">
                <div className="micro-label mb-2">
                  Cost trend by model
                </div>
                {trend ? (
                  <TimeseriesChart data={trend} metric="costUsd" height={180} />
                ) : (
                  <Skeleton className="h-[180px] w-full rounded-control" />
                )}
              </GlassPanel>
            </>
          )}
        </>
      )}
    </>
  )
}
