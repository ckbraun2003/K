import { useQuery } from '@tanstack/react-query'
import type { InboxItemKind } from '@k/shared'
import { INBOX_KEY, inboxQueryFn, EMPTY_INBOX } from '../../../lib/inbox-query'
import { navigate } from '../../../lib/route'

/**
 * NeedsYouWidget (UI Simplification Task 13) — the rail badge's per-kind
 * breakdown surfaced as a widget. Reads the ONE shared inbox query
 * (inbox-query.ts) the Sidebar badge + InboxPage both key off, so this
 * widget adds zero extra fetches and stays live via the Shell-level
 * `makeInboxInvalidator` (['inbox'] key). Mirrors InboxPage's SECTION_ORDER
 * / SECTION_LABEL (not exported there — duplicated here rather than
 * widening that page's public surface for a two-widget-only string map;
 * see task report).
 */
const SECTION_ORDER: InboxItemKind[] = ['plan_pending', 'input_needed', 'review_ready', 'lesson_pending', 'mcp_trust']
const SECTION_LABEL: Record<InboxItemKind, string> = {
  plan_pending: 'Plans to approve', input_needed: 'Runs waiting on your reply',
  review_ready: 'Ready for review', lesson_pending: 'Lessons to approve', mcp_trust: 'MCP servers to trust',
}

export default function NeedsYouWidget() {
  const { data } = useQuery({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
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
      {box.total === 0 ? (
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
