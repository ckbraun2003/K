import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'
import { makeRunUpdateInvalidator } from '../lib/live-invalidate'
import { RUNS_LIST_KEY, runsListQueryFn } from '../lib/runs-query'

export default function ActivityStrip() {
  const qc = useQueryClient()
  // The shared default-runs-list query — ONE key + fn for every consumer (see
  // runs-query.ts), so the cache entry can't be fed by drifting queryFns.
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn, refetchInterval: 10_000 })

  // run_update → invalidate runs/metrics per message + the org keys throttled
  // (policy + tests live in live-invalidate.ts). dispose() cancels any pending
  // trailing invalidation on unmount.
  useEffect(() => {
    const invalidator = makeRunUpdateInvalidator(qc)
    const unsubscribe = onWsMessage(invalidator.handler)
    return () => {
      unsubscribe()
      invalidator.dispose()
    }
  }, [qc])

  const active = runs.filter(r => r.status === 'running' || r.status === 'queued')
  const lastDone = runs.find(r => r.status === 'done' || r.status === 'error' || r.status === 'killed' || r.status === 'interrupted')

  return (
    <footer className="glass relative z-10 flex items-center gap-5 overflow-x-auto whitespace-nowrap border-x-0 border-b-0 border-t px-4 py-1.5 text-xs">
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
      {/* Day totals (runs / cost / tokens) intentionally live ONLY on the Metrics
          page's "Today" tiles (D-026 / CLAIM-08-5) — they were duplicated here on
          every page, so the strip stays focused on live/last run activity (F-004). */}
    </footer>
  )
}
