import { useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsSummary, MetricsTimeseries, RoutingStats, TimeseriesGroupBy } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCompact, formatUsd, weightedSuccessRate, weightedAvgLatencyMs } from '../lib/format-metrics'
import TimeseriesChart from '../components/TimeseriesChart'
import MetricCard from '../components/MetricCard'
import type { Metric } from '../lib/chart'

type Days = 14 | 30 | 60

function SegControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--raised)] p-0.5 gap-0.5">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors duration-150',
            value === opt.value
              ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** Bar colour for a series, keyed to its ORIGINAL position in `data.series` (the same
 *  index the stacked chart colours by) — so a series gets the SAME swatch here and in
 *  the chart above, even though this panel re-sorts rows by cost. 'other' is fixed. */
function barColor(key: string, seriesIndex: number): string {
  if (key === 'other') return 'var(--chart-other)'
  return `var(--chart-${(seriesIndex % 8) + 1})`
}

/**
 * A ranked cost-by-<dimension> panel: the timeseries `series` sorted by window
 * cost desc, rendered as proportional horizontal bars. No chart — just bars, so
 * the two panels stay lightweight next to the stacked chart above them.
 */
function CostBreakdown({
  title,
  data,
  isLoading,
  error,
}: {
  title: string
  data?: MetricsTimeseries
  isLoading: boolean
  error?: unknown
}) {
  const rows = useMemo(() => {
    if (!data) return []
    // Keep each series' ORIGINAL index (its colour anchor in the chart above) while
    // re-ranking the rows by window cost.
    return data.series
      .map((s, seriesIndex) => ({ s, seriesIndex }))
      .filter(r => r.s.total.costUsd > 0)
      .sort((a, b) => b.s.total.costUsd - a.s.total.costUsd)
  }, [data])
  const max = rows.length > 0 ? rows[0].s.total.costUsd : 0

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{title}</h2>
      {error ? (
        <div className="text-sm text-[var(--red)]">{String((error as Error).message ?? error)}</div>
      ) : isLoading && !data ? (
        <div className="text-sm text-[var(--muted)]">loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-[var(--muted)]">no cost in window</div>
      ) : (
        <div className="space-y-2">
          {rows.map(({ s, seriesIndex }) => {
            const pct = max > 0 ? (s.total.costUsd / max) * 100 : 0
            return (
              <div key={s.key} className="flex items-center gap-3">
                <span className="w-28 flex-shrink-0 truncate text-xs text-[var(--text)]" title={s.label}>
                  {s.label}
                </span>
                <div className="relative h-3 flex-1 overflow-hidden rounded bg-[var(--raised)]">
                  <div
                    className="absolute inset-y-0 left-0 rounded"
                    style={{ width: `${pct}%`, background: barColor(s.key, seriesIndex) }}
                  />
                </div>
                <span className="mono w-16 flex-shrink-0 text-right text-xs text-[var(--text)]">
                  {formatUsd(s.total.costUsd)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MetricsPage() {
  const [groupBy, setGroupBy] = useState<TimeseriesGroupBy>('project')
  const [days, setDays] = useState<Days>(30)
  const [metric, setMetric] = useState<Metric>('tokens')

  const { data, isLoading, error } = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, groupBy],
    queryFn: () => api.metrics.timeseries(days, groupBy),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData, // no flash when switching days/groupBy
  })

  // KPI feeds — the daily rollup + lifetime totals, and the per-model routing
  // outcome aggregates (weighted for the two derived tiles). Both refetch on the
  // same 30s cadence as the chart.
  const { data: summary } = useQuery<MetricsSummary>({
    queryKey: ['metrics-summary'],
    queryFn: () => api.metrics.summary(),
    refetchInterval: 30_000,
  })
  const { data: routing } = useQuery<RoutingStats>({
    queryKey: ['metrics-routing', days],
    queryFn: () => api.metrics.routing(days),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  // Two fixed-grouping reads for the cost-breakdown panels. When the page toggle
  // already selects this grouping, react-query dedupes on the shared key above —
  // no duplicate request.
  const byModel = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, 'model'],
    queryFn: () => api.metrics.timeseries(days, 'model'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })
  const byProject = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, 'project'],
    queryFn: () => api.metrics.timeseries(days, 'project'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  // Summary-derived tile values (guarded — data is undefined while loading).
  const daily = summary?.daily ?? []
  const todayCost = summary?.today.costUsd ?? 0
  const todayRuns = summary?.today.runs ?? 0
  const todayTokens = summary?.today.tokens ?? 0
  const activeRuns = summary?.activeRuns ?? 0
  const totalRuns = summary?.totalRuns ?? 0
  const cost14d = daily.reduce((sum, d) => sum + d.costUsd, 0)

  // Routing-derived tiles. Each is weighted by the SAME denominator the per-group
  // stat uses — terminal count for success, latency-sample count for latency — NOT
  // total runs, so many non-terminal (active/queued) runs can't drag them down.
  const groups = routing?.groups ?? []
  const terminalRuns = groups.reduce((sum, g) => sum + g.terminalRuns, 0)
  const successRate = weightedSuccessRate(groups)
  const avgLatencyMs = weightedAvgLatencyMs(groups)

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* page header */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Metrics</h1>
      </div>

      {/* KPI tile row — summary rollups + weighted routing aggregates */}
      <div className="mb-4 flex flex-wrap gap-3">
        <MetricCard label="Today · Cost" value={formatUsd(todayCost)} spark={daily.map(d => d.costUsd)} />
        <MetricCard label="Today · Runs" value={String(todayRuns)} spark={daily.map(d => d.runs)} />
        <MetricCard label="Today · Tokens" value={formatCompact(todayTokens)} spark={daily.map(d => d.tokens)} />
        <MetricCard label="Active runs" value={String(activeRuns)} accent={activeRuns > 0} />
        <MetricCard label="Total runs" value={String(totalRuns)} />
        <MetricCard label="14d · Cost" value={formatUsd(cost14d)} spark={daily.map(d => d.costUsd)} />
        <MetricCard
          label="Success rate"
          value={`${(successRate * 100).toFixed(1)}%`}
          accent={terminalRuns > 0 && successRate >= 0.9}
          tone="positive"
        />
        <MetricCard label="Avg latency" value={`${(avgLatencyMs / 1000).toFixed(1)}s`} />
      </div>

      {/* controls row */}
      <div className="mb-4 flex flex-wrap gap-3">
        <SegControl<TimeseriesGroupBy>
          options={[
            { label: 'By Project', value: 'project' },
            { label: 'By Model', value: 'model' },
          ]}
          value={groupBy}
          onChange={setGroupBy}
        />
        <SegControl<string>
          options={[
            { label: '14d', value: '14' },
            { label: '30d', value: '30' },
            { label: '60d', value: '60' },
          ]}
          value={String(days)}
          onChange={v => setDays(Number(v) as Days)}
        />
        <SegControl<Metric>
          options={[
            { label: 'Tokens', value: 'tokens' },
            { label: 'Cost', value: 'costUsd' },
            { label: 'Runs', value: 'runs' },
          ]}
          value={metric}
          onChange={setMetric}
        />
      </div>

      {/* chart card */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        {isLoading && !data && (
          <div className="flex h-[180px] items-center justify-center text-sm text-[var(--muted)]">
            loading…
          </div>
        )}
        {error && (
          <div className="flex h-[180px] items-center justify-center text-sm text-[var(--red)]">
            {String((error as Error).message ?? error)}
          </div>
        )}
        {data && (
          <TimeseriesChart data={data} metric={metric} height={180} />
        )}
      </div>

      {/* ranked cost breakdowns — both groupings, bars not charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CostBreakdown title="Cost by model" data={byModel.data} isLoading={byModel.isLoading} error={byModel.error} />
        <CostBreakdown title="Cost by project" data={byProject.data} isLoading={byProject.isLoading} error={byProject.error} />
      </div>
    </div>
  )
}
