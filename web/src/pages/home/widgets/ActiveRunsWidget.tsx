import { useQuery } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { RUNS_LIST_KEY, runsListQueryFn, isActiveRun, isParkedRun } from '../../../lib/runs-query'
import { runStatusMeta } from '../../../lib/status'
import { cleanRunPrompt } from '../../../lib/prompt'
import { navigate } from '../../../lib/route'

/**
 * ActiveRunsWidget (UI Simplification Task 13) — ports ActivityStrip's
 * active/parked rows (formerly ActivityStrip.tsx:51-86) into a 3x3 grid
 * cell. Reads the ONE shared default-runs-list query (runs-query.ts) — the
 * same cache entry ActivityStrip/RunList/Sidebar all shared — so
 * this widget adds zero extra fetches and stays live via the Shell-level
 * `run_update` invalidator (useLiveInvalidators → ['runs'] prefix).
 *
 * Parked (`awaiting_input` / `awaiting_plan`) rows sort first — they hold a
 * live CLI process or a plan waiting on the OPERATOR, so they must never
 * read as "just another running row" (F-055) — then active (`running` /
 * `queued`) rows, capped at 6 total so the cell never grows unbounded.
 * Color/label come from the canonical `runStatusMeta` (E-11) — never a
 * locally-invented palette — so a parked row always reads amber
 * ("awaiting input" / "plan ready") and a running row always reads green.
 */
export default function ActiveRunsWidget() {
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn, refetchInterval: 10_000 })

  const parked = runs.filter(isParkedRun)
  const active = runs.filter(isActiveRun)
  const rows = [...parked, ...active].slice(0, 6)

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Active runs</h2>
      {rows.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">Idle — no agents running.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map(r => {
            const meta = runStatusMeta(r.status)
            return (
              <button
                key={r.id}
                type="button"
                data-testid="widget-active-runs-row"
                onClick={() => navigate('runs', r.id)}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-[var(--raised)]"
              >
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${meta.dot}`} />
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{cleanRunPrompt(r.prompt)}</span>
                <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}>
                  {meta.label}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
