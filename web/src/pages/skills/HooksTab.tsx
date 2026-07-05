import { useQuery } from '@tanstack/react-query'
import type { CatalogHooksResponse } from '@k/shared'
import { api } from '../../lib/api'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'

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
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        Hooks · {hooks.length} visible
      </h2>

      {/* Permanent scope banner — visibility, never execution. */}
      <div
        data-testid="hooks-info-banner"
        className="mt-3 rounded-xl border border-[color:rgba(56,189,248,0.35)] bg-[color:rgba(56,189,248,0.08)] px-4 py-3 text-xs text-[var(--text)]"
      >
        Listed for visibility only — K never executes host hooks inside managed runs; K's own
        gitnexus hook is the only hook the synthesizer mounts.
      </div>

      <div className="mt-4">
        <WarningsBanner warnings={data?.warnings ?? []} />

        {isLoading && <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading…</p>}
        {isError && (
          <p className="mt-10 text-center text-sm text-[var(--red)]">Failed to load hooks.</p>
        )}
        {!isLoading && !isError && hooks.length === 0 && (
          <p data-testid="hooks-empty" className="mt-10 text-center text-sm text-[var(--muted)]">
            No hooks found on the host.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {hooks.map(hook => (
            <div
              key={hook.id}
              data-testid={`hook-row-${hook.id}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium text-[var(--text)]">{hook.event}</span>
                <SourceBadge sourceKind={hook.sourceKind} pluginName={hook.pluginName} />
                {hook.matcher && (
                  <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                    matcher: {hook.matcher}
                  </span>
                )}
              </div>
              <p className="mono mt-1 break-all text-[11px] text-[var(--muted)]">{hook.commandSummary}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
