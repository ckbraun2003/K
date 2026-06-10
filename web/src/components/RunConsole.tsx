import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { Run, AgentEvent, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'

interface Props {
  runId: string
}

const EVENT_COLOR: Record<string, string> = {
  system:    'text-[var(--muted)]',
  assistant: 'text-[var(--text)]',
  user:      'text-blue-400',
  usage:     'text-green-400',
  error:     'text-red-400',
  status:    'text-yellow-400',
}

export default function RunConsole({ runId }: Props) {
  const qc = useQueryClient()
  const [events, setEvents] = useState<AgentEvent[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: run } = useQuery<Run>({
    queryKey: ['run', runId],
    queryFn: () => api.runs.get(runId),
  })

  // Live events via WS
  useEffect(() => {
    setEvents([]) // reset when run changes
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'event' && msg.event.runId === runId) {
        setEvents(prev => [...prev, msg.event])
      }
      if (msg.type === 'run_update' && msg.run.id === runId) {
        qc.setQueryData(['run', runId], msg.run)
      }
    })
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
          <span className={cn('text-xs px-2 py-0.5 rounded font-semibold', {
            'bg-blue-500/20 text-blue-400 animate-pulse': run.status === 'running',
            'bg-green-500/20 text-green-400': run.status === 'done',
            'bg-red-500/20 text-red-400': run.status === 'error',
            'bg-yellow-500/20 text-yellow-400': run.status === 'queued',
            'bg-gray-500/20 text-gray-400': run.status === 'killed',
          })}>
            {run.status}
          </span>
          {run.status === 'running' && (
            <button
              onClick={handleKill}
              className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Kill
            </button>
          )}
        </div>
      </div>

      {/* Event stream */}
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
              <span className="text-purple-400">⚙ {e.tool}()</span>
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
    </div>
  )
}
