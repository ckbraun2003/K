import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { Run, AgentEvent, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'
import RunTimeline from './RunTimeline'

interface Props {
  runId: string
}

/**
 * Merge backfilled history with live events, deduped by id and sorted by seq.
 * Live events may arrive out of order (or before the backfill resolves), so the
 * merged result is re-sorted by `seq` for stable, in-order rendering.
 * Extracted as a pure function so the ordering contract can be unit-tested.
 */
export function mergeEvents(history: AgentEvent[], live: AgentEvent[]): AgentEvent[] {
  const seen = new Set(history.map(e => e.id))
  return [...history, ...live.filter(e => !seen.has(e.id))].sort((a, b) => a.seq - b.seq)
}

export const EVENT_COLOR: Record<string, string> = {
  system:    'text-[var(--muted)]',
  assistant: 'text-[var(--text)]',
  user:      'text-[var(--accent-hover)]',
  usage:     'text-[var(--green)]',
  error:     'text-[var(--red)]',
  status:    'text-[var(--amber)]',
}

export default function RunConsole({ runId }: Props) {
  const qc = useQueryClient()
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [view, setView] = useState<'console' | 'timeline'>('console')
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: run } = useQuery<Run>({
    queryKey: ['run', runId],
    queryFn: () => api.runs.get(runId),
  })

  // Persisted history + live events via WS (deduped by event id — live
  // events can arrive while the backfill request is in flight)
  useEffect(() => {
    setEvents([]) // reset when run changes
    let cancelled = false
    const unsub = onWsMessage((msg: WsMessage) => {
      if (msg.type === 'event' && msg.event.runId === runId) {
        setEvents(prev => [...prev, msg.event])
      }
      if (msg.type === 'run_update' && msg.run.id === runId) {
        qc.setQueryData(['run', runId], msg.run)
      }
    })
    // Fetch without raw — live WS events carry raw inline; backfilled events
    // fetch raw lazily per-expand via api.runs.eventRaw (see RunTimeline).
    api.runs.events(runId).then(history => {
      if (cancelled) return
      setEvents(prev => mergeEvents(history, prev))
    }).catch(() => { /* live stream still works without backfill */ })
    return () => { cancelled = true; unsub() }
  }, [runId, qc])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  async function handleKill() {
    await api.runs.kill(runId)
  }

  if (!run) return <div className="flex-1 flex items-center justify-center text-[var(--muted)]">Loading…</div>

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--text)] truncate">{run.prompt}</p>
          <p className="text-xs text-[var(--muted)]">
            {run.model} · {run.tokensIn.toLocaleString()} in / {run.tokensOut.toLocaleString()} out · ${run.costUsd.toFixed(4)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Console | Timeline toggle */}
          <div className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--raised)] p-0.5 gap-0.5">
            {(['console', 'timeline'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors duration-150 capitalize',
                  view === v
                    ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
                    : 'text-[var(--muted)] hover:text-[var(--text)]'
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <span className={cn('text-xs px-2 py-0.5 rounded font-semibold', {
            'bg-accent/15 text-[var(--accent-hover)] glow-live': run.status === 'running',
            'bg-green/15 text-[var(--green)]': run.status === 'done',
            'bg-red/15 text-[var(--red)]': run.status === 'error' || run.status === 'interrupted',
            'bg-amber/15 text-[var(--amber)]': run.status === 'queued',
            'bg-muted/15 text-[var(--muted)]': run.status === 'killed',
          })}>
            {run.status}
          </span>
          {run.status === 'running' && (
            <button
              onClick={handleKill}
              className="text-xs px-2 py-0.5 rounded bg-red/20 text-[var(--red)] hover:bg-red/30 transition-colors"
            >
              Kill
            </button>
          )}
        </div>
      </div>

      {view === 'timeline' ? (
        // key={runId} remounts on run switch so per-seq raw cache never leaks across runs
        <RunTimeline key={runId} events={events} runId={runId} />
      ) : (
        /* Event stream */
        <div className="flex-1 overflow-y-auto px-5 py-4 font-mono text-sm space-y-0.5">
          {events.length === 0 && (
            <div className="text-[var(--muted)] italic">Waiting for output…</div>
          )}
          {events.map(e => (
            <motion.div
              key={e.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.1 }}
              className={cn('leading-relaxed whitespace-pre-wrap break-words', EVENT_COLOR[e.type] ?? 'text-[var(--text)]')}
            >
              {e.type === 'status' && (
                <span className="text-[var(--muted)]">── {e.text} ──</span>
              )}
              {e.type === 'usage' && (
                <span>
                  ▸ {e.tokensIn?.toLocaleString()} in / {e.tokensOut?.toLocaleString()} out
                  {e.costUsd ? ` / $${e.costUsd.toFixed(4)}` : ''}
                </span>
              )}
              {e.type === 'error' && (
                <span>⚠ {e.text}</span>
              )}
              {e.type === 'assistant' && e.tool && (
                <span className="text-[var(--accent-hover)]">⚙ {e.tool}()</span>
              )}
              {e.type === 'assistant' && !e.tool && e.text && (
                <span>{e.text}</span>
              )}
              {(e.type === 'system' || e.type === 'user') && e.text && (
                <span className="opacity-60">{e.text}</span>
              )}
            </motion.div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
