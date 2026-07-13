import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FeedPayload, FeedKind } from '@k/shared'
import { cn } from '../lib/cn'
import { EMPTY_FEED, feedQueryFnLimited, FEED_ICON } from '../lib/feed-query'
import FeedRow from '../components/FeedRow'
import NarrativeCard from '../components/NarrativeCard'
import { EmptyState } from '../ui/EmptyState'

const ALL_KINDS: FeedKind[] = ['dispatch', 'park', 'plan_gate', 'review_ready', 'pr', 'merge', 'verify_pass', 'verify_fail', 'failure', 'done']
const TIMELINE_LIMIT = 500
// Digest mounts one NarrativeCard per eligible row, and each card fires
// GET /runs/:id/narrative (a bounded local-model call when Ollama is up). Cap the
// mounted cards so a single toggle can't stampede the local model across a long
// history (SEAMS MED-1). The cap bounds the fan-out; the rest of the rows still show.
const DIGEST_CAP = 12

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
  // Bound the digest fan-out: only the first DIGEST_CAP eligible rows mount a card.
  const digestIds = digest
    ? new Set(shown.filter(i => i.runId && (i.kind === 'done' || i.kind === 'review_ready')).slice(0, DIGEST_CAP).map(i => i.id))
    : null
  // Honest "showing N of M": M is the per-kind count across the whole window
  // (counts survive the display slice), summed over the active filter — or `total`
  // when unfiltered. Surfaces the display-cap truncation instead of hiding it (SEAMS MED-2).
  const windowTotal = active.size ? [...active].reduce((s, k) => s + (feed.counts[k] ?? 0), 0) : feed.total

  return (
    <div data-testid="timeline-page" className="flex-1 overflow-y-auto p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold text-text">Org timeline</h1>
        <div className="ml-auto flex items-center gap-1">
          {ALL_KINDS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              aria-pressed={active.has(k)}
              data-testid={`feed-chip-${k}`}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                active.has(k) ? 'bg-accent text-on-accent' : 'bg-raised text-muted',
              )}
            >
              <span aria-hidden="true">{FEED_ICON[k]}</span> {k.replace('_', ' ')} <span className="mono">{feed.counts[k] ?? 0}</span>
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-[10px] text-muted">
            <input type="checkbox" checked={digest} onChange={e => setDigest(e.target.checked)} data-testid="feed-digest-toggle" />
            digest
          </label>
        </div>
      </header>
      <div className="flex flex-col gap-0.5">
        {shown.length === 0 && <EmptyState icon="timeline" headline="No activity yet" />}
        {shown.map(item => (
          <div key={item.id}>
            <FeedRow item={item} />
            {digestIds?.has(item.id) && item.runId && (
              <div data-testid="feed-digest-card" className="ml-6 my-1"><NarrativeCard runId={item.runId} /></div>
            )}
          </div>
        ))}
      </div>
      {windowTotal > shown.length && (
        <p data-testid="feed-truncation" className="mt-2 px-2 text-[10px] text-muted">
          showing <span className="mono">{shown.length}</span> of <span className="mono">{windowTotal}</span>{active.size ? ' matching' : ''} events
        </p>
      )}
    </div>
  )
}
