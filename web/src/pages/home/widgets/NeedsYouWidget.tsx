import { useQuery } from '@tanstack/react-query'
import type { InboxItemKind } from '@k/shared'
import { EMPTY_INBOX } from '../../../lib/inbox-query'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'
import { SectionHeader } from '../../../ui/SectionHeader'
import { Skeleton } from '../../../ui/Skeleton'

/**
 * NeedsYouWidget (UI Simplification Task 13) — the rail badge's per-kind
 * breakdown surfaced as a widget.
 *
 * Deliberately does NOT read the shared `['inbox']` / `inboxQueryFn` cache
 * entry (inbox-query.ts) that the Sidebar badge / MessageDock / InboxPage
 * key off: that fn swallows a fetch failure into `EMPTY_INBOX` on purpose
 * (a dead core must not paint the always-on rail badge red). This widget is
 * a dashboard tile, not ambient chrome — a failed fetch here must render an
 * explicit error, never a fabricated "Inbox zero." (final-review fix). Two
 * different queryFn contracts can't safely share one queryKey (whichever
 * observer's fn last wins the cache entry), so this widget gets its OWN
 * `['inbox', 'widget']` key — still covered by the Shell-level
 * `makeInboxInvalidator` (prefix-matches `['inbox']`) — at the cost of one
 * extra `GET /api/inbox` alongside the badge's when Home is mounted.
 * Mirrors InboxPage's SECTION_ORDER / SECTION_LABEL (not exported there —
 * duplicated here rather than widening that page's public surface for a
 * two-widget-only string map; see task report).
 */
const NEEDS_YOU_KEY = ['inbox', 'widget'] as const
const SECTION_ORDER: InboxItemKind[] = ['plan_pending', 'input_needed', 'review_ready', 'proposal', 'lesson_pending', 'mcp_trust']
const SECTION_LABEL: Record<InboxItemKind, string> = {
  plan_pending: 'Plans to approve', input_needed: 'Runs waiting on your reply',
  review_ready: 'Ready for review', proposal: 'Proposals to approve',
  lesson_pending: 'Lessons to approve', mcp_trust: 'MCP servers to trust',
}

export default function NeedsYouWidget() {
  const { data, isError, isPending } = useQuery({ queryKey: NEEDS_YOU_KEY, queryFn: () => api.inbox.list() })
  const box = data ?? EMPTY_INBOX

  return (
    <button
      type="button"
      data-testid="widget-needs-you"
      aria-label={`Open inbox — ${box.total} item${box.total === 1 ? '' : 's'} need you`}
      onClick={() => navigate('personal', 'inbox')}
      className="flex h-full w-full flex-col gap-2 overflow-y-auto p-3 text-left transition-colors hover:bg-[var(--glass-hover)]"
    >
      <SectionHeader label="Needs you" />
      {/* The count headline is DATA-DERIVED, so it is gated on !isError alongside the chips —
          a failed fetch must render error-only, never a fabricated "0 items" above the error
          line (mirrors CostTodayWidget/ActiveRunsWidget's no-fake-zero posture). */}
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="space-y-2">
          <Skeleton className="h-7 w-14" />
          <div className="flex gap-1">
            <Skeleton className="h-5 w-24 rounded-pill" />
            <Skeleton className="h-5 w-20 rounded-pill" />
          </div>
        </div>
      ) : isError ? (
        <p data-testid="widget-needs-you-error" className="text-caption text-red">Failed to load inbox.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="mono text-display text-text">{box.total}</span>
            <span className="text-caption text-muted">item{box.total === 1 ? '' : 's'}</span>
          </div>
          {box.total === 0 ? (
            <p className="text-caption text-muted">Inbox zero.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {SECTION_ORDER.filter(kind => box.counts[kind] > 0).map(kind => (
                <span
                  key={kind}
                  data-testid={`widget-needs-you-chip-${kind}`}
                  className="rounded-pill bg-amber/15 px-2 py-0.5 text-micro font-medium text-amber"
                >
                  {SECTION_LABEL[kind]} · {box.counts[kind]}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </button>
  )
}
