import { useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsTimeseries, RoutingStats } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import TimeseriesChart from '../components/TimeseriesChart'

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

/** Cost → '$0.0123' / '$0' / '$1.50'. Non-finite → '—'. */
export function formatCost(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  if (v < 1) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

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

export default function RoutingPage() {
  const [days, setDays] = useState<Days>(30)

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
    <div className="h-full overflow-y-auto p-5">
      {/* page header */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Routing</h1>
        <SegControl<string>
          options={[
            { label: '14d', value: '14' },
            { label: '30d', value: '30' },
            { label: '60d', value: '60' },
          ]}
          value={String(days)}
          onChange={v => setDays(Number(v) as Days)}
        />
      </div>

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
        <>
          {/* recommendation banner */}
          <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
              Recommendation
            </div>
            <p className="text-sm text-[var(--text)]">{data.recommendation}</p>
          </div>

          {groups.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center text-center text-sm text-[var(--muted)]">
              No run history yet — routing insights appear once runs complete.
            </div>
          ) : (
            <>
              {/* per-model table */}
              <div className="mb-4 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-[0.08em] text-[var(--muted)]">
                      <th className="px-3 py-2 text-left font-medium">Provider</th>
                      <th className="px-3 py-2 text-left font-medium">Model</th>
                      <th className="px-3 py-2 text-right font-medium">Runs</th>
                      <th className="px-3 py-2 text-right font-medium">Success</th>
                      <th className="px-3 py-2 text-right font-medium">Avg $</th>
                      <th className="px-3 py-2 text-right font-medium">Total $</th>
                      <th className="px-3 py-2 text-right font-medium">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {groups.map(g => (
                      <tr key={`${g.provider} ${g.model}`} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2 text-left font-sans text-[var(--text)]">{g.provider}</td>
                        <td className="px-3 py-2 text-left font-sans text-[var(--muted)]">{g.model}</td>
                        <td className="px-3 py-2 text-right text-[var(--text)]">{g.runs}</td>
                        <td className="px-3 py-2 text-right text-[var(--text)]">{formatSuccessRate(g.successRate)}</td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">{formatCost(g.avgCostUsd)}</td>
                        <td className="px-3 py-2 text-right text-[var(--text)]">{formatCost(g.totalCostUsd)}</td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">{formatLatency(g.avgLatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* trend chart (cost per model) */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  Cost trend by model
                </div>
                {trend ? (
                  <TimeseriesChart data={trend} metric="costUsd" height={180} />
                ) : (
                  <div className="flex h-[180px] items-center justify-center text-sm text-[var(--muted)]">
                    loading…
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
