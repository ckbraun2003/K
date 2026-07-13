import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentEvent, RunCheckpoint } from '@k/shared'
import { cn } from '../lib/cn'
import { EVENT_COLOR } from './RunConsole'
import { api } from '../lib/api'
import RewindDialog from './RewindDialog'
import { Button } from '../ui/Button'

interface Props {
  events: AgentEvent[]
  runId: string
  /** Gates the "Rewind here" affordance (visible for terminal runs only) —
   *  RunConsole threads its already-computed terminal predicate here. */
  terminal?: boolean
}

// Format a unix-ms timestamp as HH:MM:SS.mmm
export function formatAbsTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

// Format a relative offset in ms as +12.3s
export function formatRelTime(offsetMs: number): string {
  return `+${(offsetMs / 1000).toFixed(1)}s`
}

// Clamp inter-event delay for replay so it stays watchable
export const MIN_REPLAY_DELAY_MS = 120
export const MAX_REPLAY_DELAY_MS = 1000
export function clampDelay(ms: number): number {
  return Math.max(MIN_REPLAY_DELAY_MS, Math.min(MAX_REPLAY_DELAY_MS, ms))
}

/**
 * Pure guard: returns true when a lazy raw fetch should be triggered.
 * Extracted so the caching policy can be tested without a React renderer.
 * Conditions: expanding (not collapsing), no inline raw on the event,
 * seq not already in the cache, seq not already in-flight.
 */
export function shouldFetchRaw(
  seq: number,
  hasRawInline: boolean,
  cache: Record<number, string | null>,
  inflight: Set<number>,
): boolean {
  return !hasRawInline && !(seq in cache) && !inflight.has(seq)
}

export default function RunTimeline({ events, runId, terminal = false }: Props) {
  const [cursor, setCursor] = useState(Math.max(0, events.length - 1))
  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // C2 — checkpoint chain (full shas live here, NOT in event text) + the
  // rewind dialog's target. Keyed by the checkpoint event's seq.
  const [rewindTarget, setRewindTarget] = useState<{ sha: string; wave: number } | null>(null)
  const { data: checkpoints } = useQuery<RunCheckpoint[]>({
    queryKey: ['run-checkpoints', runId],
    queryFn: () => api.runs.checkpoints(runId),
  })
  const ckptBySeq = new Map((checkpoints ?? []).map(c => [c.seq, c]))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Per-row refs so play/seek can scroll the cursor row into view (F-080) — the
  // replay was blind: it dimmed future rows + moved the counter but never scrolled,
  // leaving the active row thousands of px off-screen.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  // Cache for lazily-fetched raw strings, keyed by seq. Null means fetch returned 404.
  // NB: seq is only unique within a run — RunConsole remounts this component with
  // key={runId}, so this state never leaks across runs.
  const [rawCache, setRawCache] = useState<Record<number, string | null>>({})
  // Mirror the cache in a ref so the toggle handler's guard always reads the
  // latest entries (not a value captured at handler-definition time). Without
  // this, rapidly expanding rows re-fetches raw the closure hasn't "seen" yet.
  // Reset semantics are preserved: the component remounts per runId (key={runId}
  // in RunConsole), so both state and ref start empty for each run.
  const rawCacheRef = useRef(rawCache)
  rawCacheRef.current = rawCache
  // Concurrency guard (ref: reliable within a render batch, no double-fetch).
  const fetchingRef = useRef<Set<number>>(new Set())
  // Same set mirrored in state so the "loading…" row actually re-renders.
  const [loadingSeqs, setLoadingSeqs] = useState<Set<number>>(new Set())

  // Reset cursor when events array identity changes (run switch)
  useEffect(() => {
    setCursor(Math.max(0, events.length - 1))
    setPlaying(false)
  }, [events])

  // Scroll the cursor row into view whenever the cursor moves — on play (the
  // engine advances it) AND on seek (the range input sets it). `block: 'nearest'`
  // scrolls the list container minimally without yanking the page (F-080).
  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor])

  // Replay engine — chained setTimeout, cleans up on unmount / pause / events change
  useEffect(() => {
    function clearTimer() {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    if (!playing || events.length === 0) {
      clearTimer()
      return
    }

    function advance(current: number) {
      const next = current + 1
      if (next >= events.length) {
        setCursor(events.length - 1)
        setPlaying(false)
        return
      }
      setCursor(next)
      const delay = clampDelay(events[next].ts - events[current].ts)
      timerRef.current = setTimeout(() => advance(next), delay)
    }

    // Schedule the first advance from the current cursor
    if (cursor < events.length - 1) {
      const delay = clampDelay(events[cursor + 1].ts - events[cursor].ts)
      timerRef.current = setTimeout(() => advance(cursor), delay)
    } else {
      // Already at end
      setPlaying(false)
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  // `cursor` is intentionally excluded: the chained-timeout engine captures the
  // cursor at play-start only and advances it itself. Adding cursor here would
  // re-fire the effect on every tick and double-schedule timers (the Phase 0
  // timer-leak bug). Scrubbing stops playback via setPlaying(false).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, events])

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-body italic">
        No events
      </div>
    )
  }

  const firstTs = events[0].ts
  const cursorEvent = events[Math.min(cursor, events.length - 1)]

  function toggleExpanded(id: string, seq: number, hasRawInline: boolean) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // Trigger lazy fetch only when: expanding (not collapsing), no inline raw,
        // not already cached, and not already in-flight.
        if (shouldFetchRaw(seq, hasRawInline, rawCacheRef.current, fetchingRef.current)) {
          fetchingRef.current.add(seq)
          setLoadingSeqs(s => new Set(s).add(seq))
          api.runs.eventRaw(runId, seq)
            .then(raw => setRawCache(c => { const n = { ...c, [seq]: raw }; rawCacheRef.current = n; return n }))
            .catch(() => setRawCache(c => { const n = { ...c, [seq]: null }; rawCacheRef.current = n; return n }))
            .finally(() => {
              fetchingRef.current.delete(seq)
              setLoadingSeqs(s => { const n = new Set(s); n.delete(seq); return n })
            })
        }
      }
      return next
    })
  }

  function handlePlayPause() {
    if (playing) {
      setPlaying(false)
      return
    }
    // Restart from beginning if at end
    if (cursor >= events.length - 1) {
      setCursor(0)
    }
    setPlaying(true)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Scrollable event list */}
      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-0">
        {events.map((e, idx) => {
          const isExpanded = expanded.has(e.id)
          const dimmed = idx > cursor

          // C2 — checkpoint events render as accent-tinted marker rows. The
          // wave/sha chip comes from the checkpoints endpoint (full sha), never
          // parsed out of event text; without a chain entry (still loading /
          // pruned) fall back to the event's display text, no rewind button.
          if (e.type === 'checkpoint') {
            const ckpt = ckptBySeq.get(e.seq)
            return (
              <div
                key={e.id}
                ref={el => { rowRefs.current[idx] = el }}
                data-testid={ckpt ? `ckpt-marker-${ckpt.wave}` : 'ckpt-marker'}
                className={cn(
                  'py-1.5 pl-2 border-b border-border last:border-0 border-l-2 border-l-accent bg-accent/5 transition-opacity duration-150',
                  dimmed ? 'opacity-25' : 'opacity-100',
                )}
              >
                <div className="mono flex items-center gap-2 text-label">
                  <span className="text-muted w-6 text-right flex-shrink-0 tabular-nums">{e.seq}</span>
                  <span className="text-muted flex-shrink-0 tabular-nums">{formatAbsTime(e.ts)}</span>
                  <span className="text-micro px-1.5 py-0.5 rounded bg-accent/15 text-accent-hover font-semibold flex-shrink-0 tabular-nums">
                    {ckpt ? `wave ${ckpt.wave} · ${ckpt.sha.slice(0, 10)}` : (e.text ?? 'checkpoint')}
                  </span>
                  {terminal && ckpt && (
                    <Button
                      variant="glass"
                      size="sm"
                      data-testid={`ckpt-rewind-${ckpt.wave}`}
                      onClick={() => setRewindTarget({ sha: ckpt.sha, wave: ckpt.wave })}
                      className="flex-shrink-0"
                    >
                      Rewind here
                    </Button>
                  )}
                </div>
              </div>
            )
          }

          let rawContent: React.ReactNode = null
          if (isExpanded) {
            // Prefer inline raw (live events); fall back to lazily-fetched cache.
            const rawStr = e.raw ?? (e.seq in rawCache ? rawCache[e.seq] : undefined)
            if (rawStr != null) {
              try {
                const parsed = JSON.parse(rawStr)
                rawContent = (
                  <pre className="mono mt-1 text-label text-muted bg-raised rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words">
                    {JSON.stringify(parsed, null, 2)}
                  </pre>
                )
              } catch {
                rawContent = (
                  <p className="mt-1 text-label text-muted italic">(no raw)</p>
                )
              }
            } else if (rawCache[e.seq] === null) {
              // Fetch returned 404 or failed
              rawContent = (
                <p className="mt-1 text-label text-muted italic">raw unavailable</p>
              )
            } else if (!e.raw && loadingSeqs.has(e.seq)) {
              // In-flight fetch (loadingSeqs is state, so this row re-renders)
              rawContent = (
                <p className="mt-1 text-label text-muted italic">loading…</p>
              )
            } else if (!e.raw) {
              rawContent = (
                <p className="mt-1 text-label text-muted italic">(no raw)</p>
              )
            }
          }

          return (
            <div
              key={e.id}
              ref={el => { rowRefs.current[idx] = el }}
              data-testid="timeline-row"
              className={cn('py-1.5 border-b border-border last:border-0 transition-opacity duration-150', dimmed ? 'opacity-25' : 'opacity-100')}
            >
              <button
                onClick={() => toggleExpanded(e.id, e.seq, !!e.raw)}
                aria-expanded={isExpanded}
                className="w-full text-left"
              >
                <div className="mono flex items-baseline gap-2 text-label">
                  <span className="text-muted w-6 text-right flex-shrink-0 tabular-nums">{e.seq}</span>
                  <span className="text-muted flex-shrink-0 tabular-nums">{formatAbsTime(e.ts)}</span>
                  <span className="text-muted flex-shrink-0 w-16 text-right tabular-nums">
                    {formatRelTime(e.ts - firstTs)}
                  </span>
                  <span className={cn('flex-shrink-0 font-semibold', EVENT_COLOR[e.type] ?? 'text-text')}>
                    {e.type}
                  </span>
                  {e.tool && (
                    <span className="text-accent-hover flex-shrink-0">{e.tool}()</span>
                  )}
                  {e.text && (
                    <span className="text-text truncate min-w-0">
                      {e.text.slice(0, 120)}
                    </span>
                  )}
                </div>
              </button>
              {rawContent}
            </div>
          )
        })}
      </div>

      {/* Replay scrubber footer */}
      <div className="flex-shrink-0 border-t border-border px-5 py-3 space-y-2 bg-surface">
        {/* Readout */}
        <div className="mono text-label text-muted tabular-nums">
          seq {cursorEvent.seq} · {cursor + 1}/{events.length} · {formatRelTime(cursorEvent.ts - firstTs)}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          <Button variant="glass" size="sm" onClick={handlePlayPause} className="flex-shrink-0">
            {playing ? 'Pause' : 'Play'}
          </Button>
          <input
            type="range"
            aria-label="Replay position"
            min={0}
            max={events.length - 1}
            value={cursor}
            onChange={e => {
              setPlaying(false)
              setCursor(Number(e.target.value))
            }}
            className="flex-1 accent-accent"
          />
        </div>
      </div>

      {/* C2 — rewind-and-redispatch dialog (opened from a checkpoint marker) */}
      <RewindDialog runId={runId} checkpoint={rewindTarget} onClose={() => setRewindTarget(null)} />
    </div>
  )
}
