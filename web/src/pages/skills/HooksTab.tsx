import { useQuery } from '@tanstack/react-query'
import type { CatalogHooksResponse } from '@k/shared'
import { api } from '../../lib/api'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { GlassPanel } from '../../ui/GlassPanel'
import { SkeletonRow } from '../../ui/Skeleton'

// Hook VISIBILITY only (scope decision, D-069): host hooks are listed so the
// operator knows what exists on the machine, but K runs execute exclusively
// K's own vendored hooks — there is no enable control here by design.

export default function HooksTab() {
  const { data, isLoading, isError } = useQuery<CatalogHooksResponse>({
    queryKey: ['capabilities', 'hooks'],
    queryFn: api.capabilities.hooks,
  })

  const hooks = data?.hooks ?? []

  return (
    <div className="h-full overflow-y-auto p-5">
      <h2 className="text-label uppercase tracking-[0.12em] text-muted">
        Hooks · {hooks.length} visible
      </h2>

      {/* Permanent scope banner — visibility, never execution. */}
      <div
        data-testid="hooks-info-banner"
        className="mt-3 rounded-control border border-accent-hover/35 bg-accent-hover/10 px-4 py-3 text-body text-text"
      >
        Listed for visibility only — K never executes host hooks inside managed runs; K's own
        gitnexus hook is the only hook the synthesizer mounts.
      </div>

      <div className="mt-4">
        <WarningsBanner warnings={data?.warnings ?? []} />

        {isLoading && (
          <div className="mt-6 flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {isError && <ErrorState message="Failed to load hooks." />}
        {!isLoading && !isError && hooks.length === 0 && (
          <div data-testid="hooks-empty" className="mt-6">
            <EmptyState icon="bolt" headline="No hooks found on the host." />
          </div>
        )}

        <div className="flex flex-col gap-2">
          {hooks.map(hook => (
            <GlassPanel
              key={hook.id}
              // solid, not glass: the host hook list can grow past the
              // ≤6-blurred-region budget — same call as CatalogTab/McpTab/
              // AutomationsTab's rows (DEV-11).
              tier="solid"
              data-testid={`hook-row-${hook.id}`}
              className="px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-body font-medium text-text">{hook.event}</span>
                <SourceBadge sourceKind={hook.sourceKind} pluginName={hook.pluginName} />
                {hook.matcher && (
                  <span className="mono rounded-pill bg-[var(--glass-4)] px-1.5 py-0.5 text-micro text-muted">
                    matcher: {hook.matcher}
                  </span>
                )}
              </div>
              <p className="mono mt-1 break-all text-caption text-muted">{hook.commandSummary}</p>
            </GlassPanel>
          ))}
        </div>
      </div>
    </div>
  )
}
