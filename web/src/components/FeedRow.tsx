import type { FeedItem } from '@k/shared'
import { FEED_ICON } from '../lib/feed-query'
import { navigate } from '../lib/route'
// relativeTime ("3d ago"/"just now") is exported from lib/verify.ts:39 (CONFIRMED) --
// NOT format-metrics.ts (which only has formatCompact).
import { relativeTime } from '../lib/verify'

const KIND_TONE: Partial<Record<FeedItem['kind'], string>> = {
  verify_fail: 'text-[var(--red)]', failure: 'text-[var(--red)]',
  verify_pass: 'text-[var(--green)]', merge: 'text-[var(--green)]',
  review_ready: 'text-[var(--amber)]', park: 'text-[var(--amber)]', plan_gate: 'text-[var(--amber)]',
}

export default function FeedRow({ item }: { item: FeedItem }) {
  const clickable = item.runId != null
  return (
    <button
      type="button"
      data-testid="feed-row"
      disabled={!clickable}
      onClick={() => clickable && navigate('runs', item.runId!)}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--raised)] disabled:cursor-default"
    >
      <span className={`w-4 text-center ${KIND_TONE[item.kind] ?? 'text-[var(--muted)]'}`}>{FEED_ICON[item.kind]}</span>
      <span className="flex-1 truncate text-[var(--text)]">{item.title}</span>
      {item.projectName && <span className="mono text-[10px] text-[var(--muted)]">{item.projectName}</span>}
      <span className="mono text-[10px] text-[var(--muted)]">{relativeTime(item.ts)}</span>
    </button>
  )
}
