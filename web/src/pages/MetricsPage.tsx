import { useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsSummary, MetricsTimeseries, MetricsQualityTimeseries, RoutingStats, TimeseriesGroupBy } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCompact, formatUsd, tileValue, weightedSuccessRate, weightedErrorRate, weightedAvgLatencyMs } from '../lib/format-metrics'
import TimeseriesChart from '../components/TimeseriesChart'
import QualityTrendChart from '../components/QualityTrendChart'
import MetricCard from '../components/MetricCard'
import type { Metric } from '../lib/chart'

/** Latency (ms) → '1.2s' for the KPI tiles. */
function fmtLatencySecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

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

/** Card wrapper around a QualityTrendChart — title + loading/error framing, mirroring
 *  CostBreakdown so the success-rate + latency trends read as the same family of panels. */
function TrendCard({
  title,
  data,
  isLoading,
  error,
  field,
  color,
  format,
  fixedMax,
}: {
  title: string
  data?: MetricsQualityTimeseries
  isLoading: boolean
  error?: unknown
  field: 'successRate' | 'avgLatencyMs'
  color: string
  format: (v: number) => string
  fixedMax?: number
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{title}</h2>
      {error ? (
        <div className="text-sm text-[var(--red)]">{String((error as Error).message ?? error)}</div>
      ) : isLoading && !data ? (
        <div className="flex h-[120px] items-center justify-center text-sm text-[var(--muted)]">loading…</div>
      ) : data ? (
        <QualityTrendChart data={data} field={field} color={color} format={format} fixedMax={fixedMax} />
      ) : null}
    </div>
  )
}

export default function MetricsPage() {
  const [groupBy, setGroupBy] = useState<TimeseriesGroupBy>('project')
  // Default 14d so the chart window matches the pinned "14d · Cost" KPI + the 14-day
  // summary rollup — one consistent default period across the page (F-083).
  const [days, setDays] = useState<Days>(14)
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
  // Third cost breakdown: by discipline-lead (the orchestrator that ran each run;
  // runs with no lead activation fold into 'Unassigned' — W9b F-084). Dedupes on the
  // shared timeseries key when the page toggle already selects 'lead'.
  const byLead = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, 'lead'],
    queryFn: () => api.metrics.timeseries(days, 'lead'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })
  // Per-day success-rate + latency trend — the time-series companion to the Success /
  // Avg-latency KPIs (same killed-/parked-excluded definitions, W9b F-087).
  const quality = useQuery<MetricsQualityTimeseries>({
    queryKey: ['quality', days],
    queryFn: () => api.metrics.quality(days),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  // Summary-derived tile values (guarded — data is undefined while loading).
  // `summaryLoading` distinguishes a COLD LOAD from a real zero so a tile shows "—"
  // instead of a convincing "$0.00 today" before the feed arrives (F-083).
  const summaryLoading = summary === undefined
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
  const routingLoading = routing === undefined
  const groups = routing?.groups ?? []
  const terminalRuns = groups.reduce((sum, g) => sum + g.terminalRuns, 0)
  const successRate = weightedSuccessRate(groups)
  const errorRate = weightedErrorRate(groups)
  const avgLatencyMs = weightedAvgLatencyMs(groups)
  // Org-wide active-latency percentiles ride the same routing payload (not weightable
  // from per-group means — computed server-side over the full sample set, W9b F-086).
  const latencyP50Ms = routing?.latencyP50Ms ?? 0
  const latencyP95Ms = routing?.latencyP95Ms ?? 0

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* page header */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Metrics</h1>
      </div>

      {/* KPI tile row — summary rollups + weighted routing aggregates */}
      <div className="mb-4 flex flex-wrap gap-3">
        <MetricCard label="Today · Cost" value={tileValue(summaryLoading, formatUsd(todayCost))} spark={daily.map(d => d.costUsd)} />
        <MetricCard label="Today · Runs" value={tileValue(summaryLoading, String(todayRuns))} spark={daily.map(d => d.runs)} />
        <MetricCard label="Today · Tokens" value={tileValue(summaryLoading, formatCompact(todayTokens))} spark={daily.map(d => d.tokens)} />
        <MetricCard label="Active runs" value={tileValue(summaryLoading, String(activeRuns))} accent={activeRuns > 0} />
        <MetricCard label="Total runs" value={tileValue(summaryLoading, String(totalRuns))} />
        <MetricCard label="14d · Cost" value={tileValue(summaryLoading, formatUsd(cost14d))} spark={daily.map(d => d.costUsd)} />
        <MetricCard
          label="Success rate"
          value={tileValue(routingLoading, `${(successRate * 100).toFixed(1)}%`)}
          accent={terminalRuns > 0 && successRate >= 0.9}
          tone="positive"
        />
        <MetricCard label="Avg latency" value={tileValue(routingLoading, fmtLatencySecs(avgLatencyMs))} />
        <MetricCard label="Latency p50" value={tileValue(routingLoading, fmtLatencySecs(latencyP50Ms))} />
        <MetricCard label="Latency p95" value={tileValue(routingLoading, fmtLatencySecs(latencyP95Ms))} />
        <MetricCard label="Error rate" value={tileValue(routingLoading, `${(errorRate * 100).toFixed(1)}%`)} />
      </div>

      {/* controls row */}
      <div className="mb-4 flex flex-wrap gap-3">
        <SegControl<TimeseriesGroupBy>
          options={[
            { label: 'By Project', value: 'project' },
            { label: 'By Model', value: 'model' },
            { label: 'By Lead', value: 'lead' },
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

      {/* ranked cost breakdowns — all three groupings, bars not charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <CostBreakdown title="Cost by model" data={byModel.data} isLoading={byModel.isLoading} error={byModel.error} />
        <CostBreakdown title="Cost by project" data={byProject.data} isLoading={byProject.isLoading} error={byProject.error} />
        <CostBreakdown title="Cost by lead" data={byLead.data} isLoading={byLead.isLoading} error={byLead.error} />
      </div>

      {/* success-rate + latency trends — the time-series companion to the single KPIs */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TrendCard
          title="Success rate / day"
          data={quality.data}
          isLoading={quality.isLoading}
          error={quality.error}
          field="successRate"
          color="var(--green)"
          format={v => `${Math.round(v * 100)}%`}
          fixedMax={1}
        />
        <TrendCard
          title="Latency / day"
          data={quality.data}
          isLoading={quality.isLoading}
          error={quality.error}
          field="avgLatencyMs"
          color="var(--chart-1)"
          format={fmtLatencySecs}
        />
      </div>
    </div>
  )
}
