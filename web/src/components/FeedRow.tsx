import type { FeedItem } from '@k/shared'
import { FEED_ICON } from '../lib/feed-query'
import { navigate } from '../lib/route'
// relativeTime ("3d ago"/"just now") is exported from lib/verify.ts:39 (CONFIRMED) --
// NOT format-metrics.ts (which only has formatCompact).
import { relativeTime } from '../lib/verify'

const KIND_TONE: Partial<Record<FeedItem['kind'], string>> = {
  verify_fail: 'text-red', failure: 'text-red',
  verify_pass: 'text-green', merge: 'text-green',
  review_ready: 'text-amber', park: 'text-amber', plan_gate: 'text-amber',
}

export default function FeedRow({ item }: { item: FeedItem }) {
  const clickable = item.runId != null
  return (
    <button
      type="button"
      data-testid="feed-row"
      disabled={!clickable}
      onClick={() => clickable && navigate('runs', item.runId!)}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-raised disabled:cursor-default"
    >
      <span className={`w-4 text-center ${KIND_TONE[item.kind] ?? 'text-muted'}`}>{FEED_ICON[item.kind]}</span>
      <span className="flex-1 truncate text-text">{item.title}</span>
      {item.projectName && <span className="mono text-[10px] text-muted">{item.projectName}</span>}
      <span className="mono text-[10px] text-muted">{relativeTime(item.ts)}</span>
    </button>
  )
}
