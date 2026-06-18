import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run, MetricsSummary, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'

export default function ActivityStrip() {
  const qc = useQueryClient()
  // ['runs'] is the shared default-list cache key (see RunList). The queryFn must
  // match RunList's limit:100 so the two consumers don't disagree under one key.
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: () => api.runs.list({ limit: 100 }), refetchInterval: 10_000 })
  const { data: metrics } = useQuery<MetricsSummary>({
    queryKey: ['metrics'],
    queryFn: api.metrics.summary,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update') {
        qc.invalidateQueries({ queryKey: ['runs'] })
        qc.invalidateQueries({ queryKey: ['metrics'] })
      }
    })
  }, [qc])

  const active = runs.filter(r => r.status === 'running' || r.status === 'queued')
  const lastDone = runs.find(r => r.status === 'done' || r.status === 'error' || r.status === 'killed')

  return (
    <footer className="relative z-10 flex items-center gap-5 overflow-x-auto whitespace-nowrap border-t border-[var(--border)] bg-surface/60 px-4 py-1.5 text-xs backdrop-blur">
      {active.length === 0 && (
        <span className="text-[var(--muted)]">idle — no agents running</span>
      )}
      {active.map(r => (
        <button
          key={r.id}
          onClick={() => navigate('runs', r.id)}
          className="flex items-center gap-2 text-[var(--text)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          <span className="glow-live h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
          <span className="max-w-72 truncate">{r.prompt}</span>
        </button>
      ))}
      {lastDone && (
        <button onClick={() => navigate('runs', lastDone.id)} className="text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]">
          last: {lastDone.status === 'done' ? '✓' : '✗'} {lastDone.prompt.slice(0, 40)}
        </button>
      )}
      <span className="mono ml-auto text-[var(--muted)]">
        {metrics ? `${metrics.today.runs} runs today · $${metrics.today.costUsd.toFixed(2)} · ${(metrics.today.tokens / 1000).toFixed(0)}k tok` : '—'}
      </span>
    </footer>
  )
}
