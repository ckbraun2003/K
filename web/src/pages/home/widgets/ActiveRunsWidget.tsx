import { useQuery } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { RUNS_LIST_KEY, runsListQueryFn, isActiveRun, isParkedRun } from '../../../lib/runs-query'
import { runStatusMeta } from '../../../lib/status'
import { cleanRunPrompt } from '../../../lib/prompt'
import { navigate } from '../../../lib/route'
import { SectionHeader } from '../../../ui/SectionHeader'
import { Icon } from '../../../ui/Icon'
import { Skeleton } from '../../../ui/Skeleton'

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
  const { data: runs = [], isError, isPending } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn, refetchInterval: 10_000 })

  const parked = runs.filter(isParkedRun)
  const active = runs.filter(isActiveRun)
  const rows = [...parked, ...active].slice(0, 6)

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <SectionHeader label="Active runs" />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 px-1.5 py-1">
              <Skeleton className="h-1.5 w-1.5 rounded-pill" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-12 rounded-pill" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p data-testid="widget-active-runs-error" className="text-caption text-red">Failed to load runs.</p>
      ) : rows.length === 0 ? (
        // Hand-rolled (not <EmptyState>): this cell renders inside OverviewView's
        // GlassPanel tier="panel" — EmptyState's own icon bubble is itself a
        // glass-panel, which would nest backdrop-filter inside backdrop-filter.
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-4 text-center">
          <Icon name="runs" size={20} className="text-muted" />
          <p className="text-body font-medium text-text">Idle — dispatch with ⌘K</p>
        </div>
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
                className="flex items-center gap-2 rounded-control px-1.5 py-1 text-left text-body transition-colors hover:bg-raised"
              >
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-pill ${meta.dot}`} />
                <span className="min-w-0 flex-1 truncate text-text">{cleanRunPrompt(r.prompt)}</span>
                <span className={`flex-shrink-0 rounded-pill px-1.5 py-0.5 text-micro font-medium ${meta.badge}`}>
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
