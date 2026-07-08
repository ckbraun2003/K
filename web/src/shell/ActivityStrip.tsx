import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'
import { makeRunUpdateInvalidator, makeProjectListInvalidator, makeCapabilitiesInvalidator, makeVerifyInvalidator } from '../lib/live-invalidate'
import { RUNS_LIST_KEY, runsListQueryFn, isActiveRun, isParkedRun } from '../lib/runs-query'
import { cleanRunPrompt } from '../lib/prompt'

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
    // github_update → refresh the projects list so an externally-registered
    // project's card appears live, without a manual reload (F-036).
    const projectListInvalidator = makeProjectListInvalidator(qc)
    // capabilities_update → refresh the catalog; terminal run_update → refresh
    // the skill draft it was authoring (wave C4).
    const capabilitiesInvalidator = makeCapabilitiesInvalidator(qc)
    // verify_update → refresh that run's verify-chip cache (E-04).
    const verifyInvalidator = makeVerifyInvalidator(qc)
    const unsubscribe = onWsMessage(msg => {
      invalidator.handler(msg)
      projectListInvalidator(msg)
      capabilitiesInvalidator(msg)
      verifyInvalidator(msg)
    })
    return () => {
      unsubscribe()
      invalidator.dispose()
    }
  }, [qc])

  const active = runs.filter(isActiveRun)
  // Parked runs (awaiting_input) hold a live CLI process waiting on the operator —
  // surfaced distinctly as "needs input" so they never read as idle (F-055).
  const needsInput = runs.filter(isParkedRun)
  const lastDone = runs.find(r => r.status === 'done' || r.status === 'error' || r.status === 'killed' || r.status === 'interrupted')

  return (
    <footer className="glass relative z-10 flex items-center gap-5 overflow-x-auto whitespace-nowrap border-x-0 border-b-0 border-t px-4 py-1.5 text-xs">
      {active.length === 0 && needsInput.length === 0 && (
        <span className="text-[var(--muted)]">idle — no agents running</span>
      )}
      {needsInput.map(r => (
        <button
          key={r.id}
          data-testid="activity-needs-input"
          onClick={() => navigate('runs', r.id)}
          className="flex items-center gap-2 font-medium text-[var(--amber)] transition-colors duration-150 hover:text-[var(--text)]"
        >
          <span className="glow-live h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
          <span className="max-w-72 truncate">needs input · {cleanRunPrompt(r.prompt)}</span>
        </button>
      ))}
      {active.map(r => (
        <button
          key={r.id}
          onClick={() => navigate('runs', r.id)}
          className="flex items-center gap-2 text-[var(--text)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          <span className="glow-live h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
          <span className="max-w-72 truncate">{cleanRunPrompt(r.prompt)}</span>
        </button>
      ))}
      {lastDone && (
        <button onClick={() => navigate('runs', lastDone.id)} className="text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]">
          last: {lastDone.status === 'done' ? '✓' : '✗'} {cleanRunPrompt(lastDone.prompt).slice(0, 40)}
        </button>
      )}
      {/* Day totals (runs / cost / tokens) intentionally live ONLY on the Metrics
          page's "Today" tiles (D-026 / CLAIM-08-5) — they were duplicated here on
          every page, so the strip stays focused on live/last run activity (F-004). */}
    </footer>
  )
}
