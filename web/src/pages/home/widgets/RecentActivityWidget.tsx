import { useQuery } from '@tanstack/react-query'
import type { FeedPayload } from '@k/shared'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'
import { groupFeedByDay } from '../../../lib/feed-query'
import FeedRow from '../../../components/FeedRow'
import { SectionHeader } from '../../../ui/SectionHeader'
import { EmptyState } from '../../../ui/EmptyState'
import { Skeleton } from '../../../ui/Skeleton'

// A dedicated key (limit=8) — distinct from KHome's ['feed'] (100) and the
// timeline's ['feed', 500] (feed-query.ts) — but still under the ['feed']
// PREFIX, so the Shell-level `makeFeedInvalidator` (run_update / notification
// / verify_update) reaches this cache entry too.
const WIDGET_FEED_KEY = ['feed', 8] as const

/**
 * RecentActivityWidget (UI Simplification Task 13) — ports KHome's "Recent
 * from your org" section (formerly KHome.tsx:429-450) into a widget cell,
 * capped at 8 rows via `api.feed.list({ limit: 8 })` (FE-4 #3: room for the
 * Today/Yesterday day grouping below to have material beyond a single
 * bucket). Reuses `FeedRow` verbatim (icon/title/project/relative-time,
 * click-through to the run) — the exact component the timeline renders.
 *
 * Calls `api.feed.list` directly rather than the shared `feedQueryFnLimited`
 * (feed-query.ts) — that helper swallows a fetch failure into `EMPTY_FEED`
 * on purpose for KHome/Timeline (a dead core must not render a phantom
 * history). This widget already owns an exclusive `['feed', 8]` cache entry
 * (no other consumer reads it), so going direct costs no extra fetch and
 * lets a failure surface honestly instead of reading as "No recent
 * activity." (final-review fix).
 */
export default function RecentActivityWidget() {
  const { data, isError, isPending } = useQuery<FeedPayload>({ queryKey: WIDGET_FEED_KEY, queryFn: () => api.feed.list({ limit: 8 }) })
  const items = data?.items ?? []
  const dayGroups = groupFeedByDay(items)

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <SectionHeader
        label="Recent activity"
        as="h2"
        action={(
          <button
            type="button"
            data-testid="widget-recent-activity-seeall"
            onClick={() => navigate('timeline')}
            className="text-caption text-accent-hover transition-colors hover:text-text"
          >
            See all →
          </button>
        )}
      />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 py-1">
              <Skeleton className="h-4 w-4 rounded-pill" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p data-testid="widget-recent-activity-error" className="text-caption text-red">Failed to load recent activity.</p>
      ) : items.length === 0 ? (
        // FU-2: tier="solid" avoids nesting glass-panel (EmptyState's default
        // icon bubble) inside this cell's GlassPanel tier="panel" ancestor
        // (OverviewView) — backdrop-filter can't stack on itself.
        <EmptyState tier="solid" icon="insights" headline="No recent activity." className="flex-1 gap-1.5 py-4" />
      ) : (
        <div className="flex flex-col gap-1">
          {dayGroups.map(group => (
            <div key={group.key}>
              <h3 data-testid="feed-day-header" className="micro-label px-0.5 py-1">{group.label}</h3>
              <div className="flex flex-col gap-0.5">
                {group.items.map(item => (
                  <FeedRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
