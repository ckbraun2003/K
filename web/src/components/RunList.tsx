import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  queued:  'bg-yellow-500/20 text-yellow-400',
  running: 'bg-blue-500/20 text-blue-400 animate-pulse',
  done:    'bg-green-500/20 text-green-400',
  error:   'bg-red-500/20 text-red-400',
  killed:  'bg-gray-500/20 text-gray-400',
}

const STATUS_DOT: Record<string, string> = {
  queued:  'bg-yellow-400',
  running: 'bg-blue-400',
  done:    'bg-green-400',
  error:   'bg-red-400',
  killed:  'bg-gray-400',
}

export default function RunList({ selectedId, onSelect }: Props) {
  const qc = useQueryClient()
  const { data: runs = [] } = useQuery<Run[]>({
    queryKey: ['runs'],
    queryFn: api.runs.list,
    refetchInterval: 5_000,
  })

  // Live updates via WebSocket
  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update') {
        qc.setQueryData<Run[]>(['runs'], old => {
          if (!old) return [msg.run]
          const idx = old.findIndex(r => r.id === msg.run.id)
          if (idx === -1) return [msg.run, ...old]
          const next = [...old]
          next[idx] = msg.run
          return next
        })
      }
    })
  }, [qc])

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Runs</h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        {runs.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
            No runs yet.<br />Press ⌘K to start one.
          </div>
        )}
        {runs.map(run => (
          <motion.button
            key={run.id}
            onClick={() => onSelect(run.id)}
            className={cn(
              'w-full text-left px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors',
              selectedId === run.id && 'bg-[var(--surface)] border-l-2 border-l-[var(--accent)]'
            )}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[run.status] ?? 'bg-gray-400')} />
              <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', STATUS_COLOR[run.status])}>
                {run.status}
              </span>
              <span className="text-xs text-[var(--muted)] ml-auto">
                ${(run.costUsd).toFixed(4)}
              </span>
            </div>
            <p className="text-sm text-[var(--text)] truncate">{run.prompt}</p>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              {new Date(run.createdAt).toLocaleTimeString()} · {run.model}
            </p>
          </motion.button>
        ))}
      </div>
    </div>
  )
}
