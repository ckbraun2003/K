import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsTimeseries, MetricsQualityTimeseries } from '@k/shared'
import { api } from '../../lib/api'
import { computeDeltas, detectAnomalies, type DeltaInput, type DeltaResult } from '../../lib/insights-deltas'
import { KpiTile } from '../../ui/KpiTile'
import { SkeletonTile } from '../../ui/Skeleton'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'

type Days = 14 | 30 | 60

// Per-metric presentation of the (measured) tile value. Formatting is presentation-only and
// lives here so insights-deltas.ts stays pure numbers (no price coupling, no display concerns).
const VALUE_FMT: Record<string, (v: number) => string> = {
  cost: (v) => `$${v.toFixed(2)}`,
  runs: (v) => String(Math.round(v)),
  success: (v) => `${Math.round(v * 100)}%`,
  latency: (v) => `${(v / 1000).toFixed(1)}s`,
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0)
/** Split a chronological series into its earlier and later halves (equal-length; the odd
 *  middle point falls into the later half). Used to derive previous-vs-current from ONE window. */
function splitHalf<T>(arr: T[]): [T[], T[]] {
  const mid = Math.floor(arr.length / 2)
  return [arr.slice(0, mid), arr.slice(mid)]
}

function DeltaTile({ d, spark, days }: { d: DeltaResult; spark?: number[]; days: Days }) {
  const value = (VALUE_FMT[d.key] ?? String)(d.current)
  // KpiTile does its own rounding-free `{delta.pct}%` — pre-round to match the old .toFixed(0)
  // display. No baseline (deltaPct == null) omits the delta prop rather than fabricating one.
  const delta = d.deltaPct == null ? undefined : {
    pct: Math.round(d.deltaPct * 100),
    polarity: (d.higherIsBetter ? 'goodUp' : 'badUp') as 'goodUp' | 'badUp',
  }
  return (
    <div data-testid={`delta-${d.key}`}>
      <KpiTile label={d.label} value={value} delta={delta} spark={spark} period={`${days}D`} />
    </div>
  )
}

/**
 * P4 E-10 Overview — DETERMINISTIC period-over-period deltas + anomaly callouts over MEASURED
 * metrics. Sourced from the WINDOWED endpoints (timeseries + quality) keyed on the shared `days`
 * window so it cross-filters with Charts/Routing (NOT summary(), which is fixed-14d/un-windowed).
 * NO LLM, NO price coupling — deltas are over measured cost_usd / run counts / rates only.
 */
export default function OverviewTab({ days }: { days: Days }) {
  // Fixed groupBy: the per-day totals (sum across series) are identical regardless of grouping;
  // 'project' shares ChartsTab's query key so react-query dedupes the request.
  const ts = useQuery<MetricsTimeseries>({
    queryKey: ['timeseries', days, 'project'],
    queryFn: () => api.metrics.timeseries(days, 'project'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })
  const quality = useQuery<MetricsQualityTimeseries>({
    queryKey: ['quality', days],
    queryFn: () => api.metrics.quality(days),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  // Per-day totals (sum every series' point at each date index) — the windowed cost/run series.
  const dates = ts.data?.dates ?? []
  const series = ts.data?.series ?? []
  const costPerDay = dates.map((_, i) => sum(series.map(s => s.points[i]?.costUsd ?? 0)))
  const runsPerDay = dates.map((_, i) => sum(series.map(s => s.points[i]?.runs ?? 0)))

  // Quality series with NULL points FILTERED OUT (successRate/avgLatencyMs are nullable — feeding a
  // null into the mean/anomaly math would yield NaN). Order is preserved so the latest point stays last.
  const qPoints = quality.data?.points ?? []
  const sr = qPoints.filter(p => p.successRate != null).map(p => p.successRate as number)
  const lat = qPoints.filter(p => p.avgLatencyMs != null).map(p => p.avgLatencyMs as number)

  const inputs: DeltaInput[] = []
  if (costPerDay.length >= 2) {
    const [e, l] = splitHalf(costPerDay)
    inputs.push({ key: 'cost', label: 'Cost', current: sum(l), previous: sum(e), higherIsBetter: false })
  }
  if (runsPerDay.length >= 2) {
    const [e, l] = splitHalf(runsPerDay)
    inputs.push({ key: 'runs', label: 'Runs', current: sum(l), previous: sum(e), higherIsBetter: true })
  }
  if (sr.length >= 2) {
    const [e, l] = splitHalf(sr)
    inputs.push({ key: 'success', label: 'Success rate', current: mean(l), previous: mean(e), higherIsBetter: true })
  }
  if (lat.length >= 2) {
    const [e, l] = splitHalf(lat)
    inputs.push({ key: 'latency', label: 'Avg latency', current: mean(l), previous: mean(e), higherIsBetter: false })
  }
  const deltas = computeDeltas(inputs)
  // Per-metric per-day series feeding each tile's sparkline — the same windowed
  // arrays the deltas themselves are computed from (no separate fetch/derivation).
  const sparkByKey: Record<string, number[]> = { cost: costPerDay, runs: runsPerDay, success: sr, latency: lat }

  const anomalies = detectAnomalies([
    ...(sr.length >= 3 ? [{ key: 'success', label: 'Success rate', series: sr, badTail: 'low' as const }] : []),
    ...(lat.length >= 3 ? [{ key: 'latency', label: 'Avg latency', series: lat, badTail: 'high' as const }] : []),
    ...(costPerDay.length >= 3 ? [{ key: 'cost', label: 'Cost', series: costPerDay, badTail: 'high' as const }] : []),
  ])

  const loading = ts.isLoading || quality.isLoading

  return (
    <div data-testid="insights-overview" className="flex flex-col gap-4">
      {deltas.length === 0 && loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonTile key={i} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {deltas.map((d) => <DeltaTile key={d.key} d={d} spark={sparkByKey[d.key]} days={days} />)}
          {deltas.length === 0 && (
            <div className="col-span-full">
              <EmptyState icon="insights" headline="No measured metrics" hint={`Nothing measured in the last ${days} days.`} />
            </div>
          )}
        </div>
      )}
      <section data-testid="overview-anomalies">
        <h2 className="mb-2 text-caption font-semibold text-text">Anomalies</h2>
        {anomalies.length === 0 ? (
          <div className="text-caption text-muted">No anomalies in the last {days} days.</div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {anomalies.map((a) => (
              <span
                key={a.key}
                data-testid={`anomaly-${a.key}`}
                title={a.reason}
                className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-micro font-medium ${
                  a.severity === 'critical' ? 'border-red/40 bg-red/10 text-red' : 'border-amber/40 bg-amber/10 text-amber'}`}
              >
                <Icon name="warning" size={14} /> {a.label}
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
