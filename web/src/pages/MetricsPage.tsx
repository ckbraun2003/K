import { useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { MetricsTimeseries, TimeseriesGroupBy } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import TimeseriesChart from '../components/TimeseriesChart'
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

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* page header */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Metrics</h1>
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
    </div>
  )
}
