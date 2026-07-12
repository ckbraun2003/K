import { useQuery } from '@tanstack/react-query'
import type { FeedPayload } from '@k/shared'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'
import FeedRow from '../../../components/FeedRow'

// A dedicated key (limit=6) — distinct from KHome's ['feed'] (100) and the
// timeline's ['feed', 500] (feed-query.ts) — but still under the ['feed']
// PREFIX, so the Shell-level `makeFeedInvalidator` (run_update / notification
// / verify_update) reaches this cache entry too.
const WIDGET_FEED_KEY = ['feed', 6] as const

/**
 * RecentActivityWidget (UI Simplification Task 13) — ports KHome's "Recent
 * from your org" section (formerly KHome.tsx:429-450) into a widget cell,
 * capped at 6 rows via `api.feed.list({ limit: 6 })`. Reuses `FeedRow`
 * verbatim (icon/title/project/relative-time, click-through to the run) —
 * the exact component the timeline renders.
 *
 * Calls `api.feed.list` directly rather than the shared `feedQueryFnLimited`
 * (feed-query.ts) — that helper swallows a fetch failure into `EMPTY_FEED`
 * on purpose for KHome/Timeline (a dead core must not render a phantom
 * history). This widget already owns an exclusive `['feed', 6]` cache entry
 * (no other consumer reads it), so going direct costs no extra fetch and
 * lets a failure surface honestly instead of reading as "No recent
 * activity." (final-review fix).
 */
export default function RecentActivityWidget() {
  const { data, isError } = useQuery<FeedPayload>({ queryKey: WIDGET_FEED_KEY, queryFn: () => api.feed.list({ limit: 6 }) })
  const items = data?.items ?? []

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Recent activity</h2>
        <button
          type="button"
          data-testid="widget-recent-activity-seeall"
          onClick={() => navigate('timeline')}
          className="text-[11px] text-[var(--accent-hover)] transition-colors hover:text-[var(--text)]"
        >
          See all →
        </button>
      </div>
      {isError ? (
        <p data-testid="widget-recent-activity-error" className="text-xs italic text-[var(--red)]">Failed to load recent activity.</p>
      ) : items.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">No recent activity.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map(item => (
            <FeedRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
