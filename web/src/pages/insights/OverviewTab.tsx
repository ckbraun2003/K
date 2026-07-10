import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsTimeseries, MetricsQualityTimeseries } from '@k/shared'
import { api } from '../../lib/api'
import { computeDeltas, detectAnomalies, type DeltaInput, type DeltaResult } from '../../lib/insights-deltas'

type Days = 14 | 30 | 60

const TONE_CLASS = { good: 'text-[var(--green)]', bad: 'text-[var(--red)]', neutral: 'text-[var(--muted)]' } as const

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

function DeltaTile({ d }: { d: DeltaResult }) {
  const pct = d.deltaPct == null ? 'new' : `${d.deltaPct >= 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%`
  const arrow = d.trend === 'up' ? '▲' : d.trend === 'down' ? '▼' : '–'
  const value = (VALUE_FMT[d.key] ?? String)(d.current)
  return (
    <div data-testid={`delta-${d.key}`} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{d.label}</div>
      <div className="mt-1 text-lg text-[var(--text)]">{value}</div>
      <div className={`text-[11px] ${TONE_CLASS[d.tone]}`}>{arrow} {pct}</div>
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

  const anomalies = detectAnomalies([
    ...(sr.length >= 3 ? [{ key: 'success', label: 'Success rate', series: sr, badTail: 'low' as const }] : []),
    ...(lat.length >= 3 ? [{ key: 'latency', label: 'Avg latency', series: lat, badTail: 'high' as const }] : []),
    ...(costPerDay.length >= 3 ? [{ key: 'cost', label: 'Cost', series: costPerDay, badTail: 'high' as const }] : []),
  ])

  const loading = ts.isLoading || quality.isLoading

  return (
    <div data-testid="insights-overview" className="flex flex-col gap-4">
      {deltas.length === 0 && loading ? (
        <div className="text-xs text-[var(--muted)]">loading…</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {deltas.map((d) => <DeltaTile key={d.key} d={d} />)}
          {deltas.length === 0 && (
            <div className="col-span-full text-xs text-[var(--muted)]">No measured metrics in the last {days} days.</div>
          )}
        </div>
      )}
      <section data-testid="overview-anomalies">
        <h2 className="mb-2 text-xs font-semibold text-[var(--text)]">Anomalies</h2>
        {anomalies.length === 0
          ? <div className="text-xs text-[var(--muted)]">No anomalies in the last {days} days.</div>
          : anomalies.map((a) => (
              <div key={a.key} data-testid={`anomaly-${a.key}`} className={`text-xs ${a.severity === 'critical' ? 'text-[var(--red)]' : 'text-[var(--amber)]'}`}>{a.reason}</div>
            ))}
      </section>
    </div>
  )
}
