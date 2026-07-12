import { useQuery } from '@tanstack/react-query'
import type { InboxItemKind } from '@k/shared'
import { EMPTY_INBOX } from '../../../lib/inbox-query'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'

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
const SECTION_ORDER: InboxItemKind[] = ['plan_pending', 'input_needed', 'review_ready', 'lesson_pending', 'mcp_trust']
const SECTION_LABEL: Record<InboxItemKind, string> = {
  plan_pending: 'Plans to approve', input_needed: 'Runs waiting on your reply',
  review_ready: 'Ready for review', lesson_pending: 'Lessons to approve', mcp_trust: 'MCP servers to trust',
}

export default function NeedsYouWidget() {
  const { data, isError } = useQuery({ queryKey: NEEDS_YOU_KEY, queryFn: () => api.inbox.list() })
  const box = data ?? EMPTY_INBOX

  return (
    <button
      type="button"
      data-testid="widget-needs-you"
      onClick={() => navigate('personal', 'inbox')}
      className="flex h-full w-full flex-col gap-2 overflow-y-auto p-3 text-left transition-colors hover:bg-[var(--raised)]"
    >
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Needs you</h2>
      <div className="flex items-baseline gap-1.5">
        <span className="mono text-2xl font-semibold text-[var(--text)]">{box.total}</span>
        <span className="text-xs text-[var(--muted)]">item{box.total === 1 ? '' : 's'}</span>
      </div>
      {isError ? (
        <p data-testid="widget-needs-you-error" className="text-xs italic text-[var(--red)]">Failed to load inbox.</p>
      ) : box.total === 0 ? (
        <p className="text-xs italic text-[var(--muted)]">Inbox zero.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {SECTION_ORDER.filter(kind => box.counts[kind] > 0).map(kind => (
            <span
              key={kind}
              data-testid={`widget-needs-you-chip-${kind}`}
              className="rounded-full bg-amber/15 px-2 py-0.5 text-[10px] font-medium text-[var(--amber)]"
            >
              {SECTION_LABEL[kind]} · {box.counts[kind]}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
