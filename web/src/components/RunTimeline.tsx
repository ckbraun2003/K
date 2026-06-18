import { useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '@k/shared'
import { cn } from '../lib/cn'
import { EVENT_COLOR } from './RunConsole'
import { api } from '../lib/api'

interface Props {
  events: AgentEvent[]
  runId: string
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

export default function RunTimeline({ events, runId }: Props) {
  const [cursor, setCursor] = useState(Math.max(0, events.length - 1))
  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache for lazily-fetched raw strings, keyed by seq. Null means fetch returned 404.
  // NB: seq is only unique within a run — RunConsole remounts this component with
  // key={runId}, so this state never leaks across runs.
  const [rawCache, setRawCache] = useState<Record<number, string | null>>({})
  // Concurrency guard (ref: reliable within a render batch, no double-fetch).
  const fetchingRef = useRef<Set<number>>(new Set())
  // Same set mirrored in state so the "loading…" row actually re-renders.
  const [loadingSeqs, setLoadingSeqs] = useState<Set<number>>(new Set())

  // Reset cursor when events array identity changes (run switch)
  useEffect(() => {
    setCursor(Math.max(0, events.length - 1))
    setPlaying(false)
  }, [events])

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
      <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-sm italic">
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
        if (shouldFetchRaw(seq, hasRawInline, rawCache, fetchingRef.current)) {
          fetchingRef.current.add(seq)
          setLoadingSeqs(s => new Set(s).add(seq))
          api.runs.eventRaw(runId, seq)
            .then(raw => setRawCache(c => ({ ...c, [seq]: raw })))
            .catch(() => setRawCache(c => ({ ...c, [seq]: null })))
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

          let rawContent: React.ReactNode = null
          if (isExpanded) {
            // Prefer inline raw (live events); fall back to lazily-fetched cache.
            const rawStr = e.raw ?? (e.seq in rawCache ? rawCache[e.seq] : undefined)
            if (rawStr != null) {
              try {
                const parsed = JSON.parse(rawStr)
                rawContent = (
                  <pre className="mt-1 text-xs text-[var(--muted)] bg-[var(--raised)] rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words">
                    {JSON.stringify(parsed, null, 2)}
                  </pre>
                )
              } catch {
                rawContent = (
                  <p className="mt-1 text-xs text-[var(--muted)] italic">(no raw)</p>
                )
              }
            } else if (rawCache[e.seq] === null) {
              // Fetch returned 404 or failed
              rawContent = (
                <p className="mt-1 text-xs text-[var(--muted)] italic">raw unavailable</p>
              )
            } else if (!e.raw && loadingSeqs.has(e.seq)) {
              // In-flight fetch (loadingSeqs is state, so this row re-renders)
              rawContent = (
                <p className="mt-1 text-xs text-[var(--muted)] italic">loading…</p>
              )
            } else if (!e.raw) {
              rawContent = (
                <p className="mt-1 text-xs text-[var(--muted)] italic">(no raw)</p>
              )
            }
          }

          return (
            <div
              key={e.id}
              className={cn('py-1.5 border-b border-[var(--border)] last:border-0 transition-opacity duration-150', dimmed ? 'opacity-25' : 'opacity-100')}
            >
              <button
                onClick={() => toggleExpanded(e.id, e.seq, !!e.raw)}
                aria-expanded={isExpanded}
                className="w-full text-left"
              >
                <div className="flex items-baseline gap-2 font-mono text-xs">
                  <span className="text-[var(--muted)] w-6 text-right flex-shrink-0">{e.seq}</span>
                  <span className="text-[var(--muted)] flex-shrink-0">{formatAbsTime(e.ts)}</span>
                  <span className="text-[var(--muted)] flex-shrink-0 w-16 text-right">
                    {formatRelTime(e.ts - firstTs)}
                  </span>
                  <span className={cn('flex-shrink-0 font-semibold', EVENT_COLOR[e.type] ?? 'text-[var(--text)]')}>
                    {e.type}
                  </span>
                  {e.tool && (
                    <span className="text-[var(--accent-hover)] flex-shrink-0">{e.tool}()</span>
                  )}
                  {e.text && (
                    <span className="text-[var(--text)] truncate min-w-0">
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
      <div className="flex-shrink-0 border-t border-[var(--border)] px-5 py-3 space-y-2 bg-[var(--surface)]">
        {/* Readout */}
        <div className="font-mono text-xs text-[var(--muted)]">
          seq {cursorEvent.seq} · {cursor + 1}/{events.length} · {formatRelTime(cursorEvent.ts - firstTs)}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          <button
            onClick={handlePlayPause}
            className="text-xs px-3 py-1 rounded bg-accent/15 text-[var(--accent-hover)] hover:bg-accent/25 transition-colors font-medium flex-shrink-0"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
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
            className="flex-1 accent-[var(--accent)]"
          />
        </div>
      </div>
    </div>
  )
}
