import { useQuery } from '@tanstack/react-query'
import type { OrchestratorRosterPayload, OrchestratorRosterEntry } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/verify'
import { GlassPanel } from '../../ui/GlassPanel'
import { StatusPill } from '../../ui/StatusPill'
import { Button } from '../../ui/Button'
import { Tag } from '../../ui/Tag'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonRow } from '../../ui/Skeleton'

/**
 * Orchestrators roster (P5.3a) — the five discipline leads as slim cards. ONE batched
 * query (api.orchestrators.list) drives the whole page: no per-lead useQuery fan-out.
 * Each card shows the lead's name, a live/idle status pill, a wakes count, and an Open
 * button into the param-routed detail view. (The charter chip was dropped — every card
 * read "ORCHESTRATOR", carrying zero signal.) Read-only here; authority edits live in
 * OrchestratorDetailPage.
 */

/** One slim roster card. Exported for render-testing (prop-fed, no queries). */
export function OrchestratorCard({ entry }: { entry: OrchestratorRosterEntry }) {
  const { profile, live, wakes, recent, latestRun } = entry
  return (
    <GlassPanel
      // solid, not glass: the lead grid is unbounded (N leads) and >6 simultaneous
      // backdrop-filter regions breaks the blur budget — same call as the fleet
      // project grid (DEV-11, web/src/components/ProjectCard.tsx).
      tier="solid"
      interactive
      className="px-4 py-3"
      data-testid={`orchestrator-card-${profile.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">
          {profile.name}
        </span>
      </div>

      {/* Recent-run health — REAL counts from the lead's activation history, never
          an invented score/band. Rendered only when there is history to report.
          NOTE: keep the literal `text-[var(--green)]` / `text-[var(--amber)]`
          arbitrary-value forms — roster-view-card.test.tsx asserts the class
          string CONTAINS the substring `--green` / `--amber`; the semantic
          `text-green` / `text-amber` utilities do not contain that substring. */}
      {recent && recent.total > 0 && (
        <p
          data-testid={`orchestrator-recent-${profile.id}`}
          className={cn('mt-1.5 text-caption', recent.failed === 0 ? 'text-[var(--green)]' : 'text-[var(--amber)]')}
        >
          {recent.succeeded}/{recent.total} recent ✓{recent.failed > 0 && ` · ${recent.failed} failed`}
        </p>
      )}

      <div className="mt-2 flex flex-wrap min-w-0 items-center gap-2 text-caption text-muted">
        {/* StatusPill has no rest-prop passthrough, so the testid lives on a wrapper span. */}
        <span data-testid={`orchestrator-status-${profile.id}`}>
          <StatusPill status={live ? 'running' : 'idle'} label={live ? 'live' : 'idle'} />
        </span>
        {/* IN-3: activity sparkline pending a per-day series on OrchestratorRosterEntry (BE). */}
        {latestRun && (
          <>
            <Tag tint="neutral" className="mono">{latestRun.model}</Tag>
            <span className="mono tabular-nums">{relativeTime(latestRun.createdAt)}</span>
          </>
        )}
        <span>
          <span className="mono tabular-nums">{wakes}</span> wake{wakes === 1 ? '' : 's'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="arrowRight"
          onClick={() => navigate('orchestrator', profile.id)}
          data-testid={`orchestrator-open-${profile.id}`}
          className="ml-auto flex-shrink-0"
        >
          Open
        </Button>
      </div>
    </GlassPanel>
  )
}

export default function RosterView() {
  const { data, isLoading, isError } = useQuery<OrchestratorRosterPayload>({
    queryKey: ['orchestrators'],
    queryFn: () => api.orchestrators.list(),
  })

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <GlassPanel
          as="button"
          tier="panel"
          interactive
          data-testid="roster-card-k"
          onClick={() => navigate('home')}
          className="p-4 text-left"
        >
          <div className="text-body font-semibold text-text">K</div>
          <div className="text-caption text-muted">Secretary — your front door. Chat lives on Home.</div>
        </GlassPanel>
        <GlassPanel
          as="button"
          tier="panel"
          interactive
          data-testid="roster-card-chief"
          onClick={() => navigate('agents', 'org', 'tree')}
          className="p-4 text-left"
        >
          <div className="text-body font-semibold text-text">Chief</div>
          <div className="text-caption text-muted">Manager — objectives & delegation. See the Tree view.</div>
        </GlassPanel>
      </div>

      <div className="mb-4 mt-4 flex items-center justify-between gap-3">
        {data && (
          <div
            className="ml-auto flex items-center gap-2 text-caption text-muted"
            data-testid="orchestrators-active"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-green" aria-hidden />
            <span className="mono tabular-nums text-text">{data.activeLeads}</span>
            <span>active</span>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="flex flex-col gap-1">
          <SkeletonRow /><SkeletonRow /><SkeletonRow />
        </div>
      )}
      {isError && <ErrorState message="Failed to load orchestrators." />}

      {data && data.leads.length === 0 && (
        <div data-testid="orchestrators-empty">
          <EmptyState icon="agents" headline="No orchestrator leads seeded yet." />
        </div>
      )}

      {data && data.leads.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.leads.map(entry => (
            <OrchestratorCard key={entry.profile.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
