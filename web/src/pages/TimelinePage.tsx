import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FeedPayload, FeedKind } from '@k/shared'
import { EMPTY_FEED, feedQueryFnLimited, FEED_ICON } from '../lib/feed-query'
import FeedRow from '../components/FeedRow'
import NarrativeCard from '../components/NarrativeCard'

const ALL_KINDS: FeedKind[] = ['dispatch', 'park', 'plan_gate', 'review_ready', 'pr', 'merge', 'verify_pass', 'verify_fail', 'failure', 'done']
const TIMELINE_LIMIT = 500

export default function TimelinePage() {
  const { data: feed = EMPTY_FEED } = useQuery<FeedPayload>({
    queryKey: ['feed', TIMELINE_LIMIT],
    queryFn: feedQueryFnLimited(TIMELINE_LIMIT),
    refetchInterval: 15_000,
  })
  const [active, setActive] = useState<Set<FeedKind>>(new Set())
  const [digest, setDigest] = useState(false)

  const toggle = (k: FeedKind) => setActive(prev => {
    const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next
  })
  const shown = active.size ? feed.items.filter(i => active.has(i.kind)) : feed.items

  return (
    <div data-testid="timeline-page" className="flex-1 overflow-y-auto p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold text-[var(--text)]">Org timeline</h1>
        <div className="ml-auto flex items-center gap-1">
          {ALL_KINDS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              data-testid={`feed-chip-${k}`}
              className={`rounded px-1.5 py-0.5 text-[10px] ${active.has(k) ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--raised)] text-[var(--muted)]'}`}
            >
              {FEED_ICON[k]} {k.replace('_', ' ')} {feed.counts[k] ?? 0}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-[10px] text-[var(--muted)]">
            <input type="checkbox" checked={digest} onChange={e => setDigest(e.target.checked)} data-testid="feed-digest-toggle" />
            digest
          </label>
        </div>
      </header>
      <div className="flex flex-col gap-0.5">
        {shown.length === 0 && <div className="p-4 text-center text-xs text-[var(--muted)]">No activity yet.</div>}
        {shown.map(item => (
          <div key={item.id}>
            <FeedRow item={item} />
            {digest && item.runId && (item.kind === 'done' || item.kind === 'review_ready') && (
              <div data-testid="feed-digest-card" className="ml-6 my-1"><NarrativeCard runId={item.runId} /></div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
