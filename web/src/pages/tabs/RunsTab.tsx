import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../../lib/api'
import { onWsMessage } from '../../lib/ws'
import { cn } from '../../lib/cn'
import RunConsole from '../../components/RunConsole'

interface Props {
  projectId: string
}

const STATUS_DOT: Record<string, string> = {
  queued:      'bg-[var(--amber)]',
  running:     'bg-[var(--accent)] glow-live',
  done:        'bg-[var(--green)]',
  error:       'bg-[var(--red)]',
  killed:      'bg-[var(--muted)]',
  interrupted: 'bg-[var(--red)]',
}

const STATUS_COLOR: Record<string, string> = {
  queued:      'bg-amber/15 text-[var(--amber)]',
  running:     'bg-accent/15 text-[var(--accent-hover)]',
  done:        'bg-green/15 text-[var(--green)]',
  error:       'bg-red/15 text-[var(--red)]',
  killed:      'bg-muted/15 text-[var(--muted)]',
  interrupted: 'bg-red/15 text-[var(--red)]',
}

export default function RunsTab({ projectId }: Props) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: runs = [] } = useQuery<Run[]>({
    queryKey: ['runs', 'project', projectId],
    queryFn: () => api.runs.list({ projectId, limit: 50 }),
    refetchInterval: 5_000,
  })

  // Live patch via WebSocket — same pattern as RunList
  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update' && msg.run.projectId === projectId) {
        qc.setQueryData<Run[]>(['runs', 'project', projectId], old => {
          if (!old) return [msg.run]
          const idx = old.findIndex(r => r.id === msg.run.id)
          if (idx === -1) return [msg.run, ...old]
          const next = [...old]
          next[idx] = msg.run
          return next
        })
      }
    })
  }, [qc, projectId])

  return (
    <div className="flex flex-col h-full">
      {/* Run list */}
      <div className={cn('flex-shrink-0 overflow-y-auto border-b border-[var(--border)]', selectedId ? 'max-h-64' : 'flex-1')}>
        {runs.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
            No runs for this project yet.
            <br />
            Use the Tasks tab to dispatch an agent run.
          </div>
        )}
        {runs.map(run => {
          const isSelected = selectedId === run.id
          return (
            <div
              key={run.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(isSelected ? null : run.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(isSelected ? null : run.id)
                }
              }}
              className={cn(
                'w-full text-left px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors cursor-pointer',
                isSelected && 'bg-[var(--surface)] border-l-2 border-l-[var(--accent)]'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[run.status] ?? 'bg-[var(--muted)]')} />
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', STATUS_COLOR[run.status])}>
                  {run.status}
                </span>
                <span className="font-mono text-xs text-[var(--muted)] ml-auto">
                  ${run.costUsd.toFixed(4)}
                </span>
              </div>
              <p className="text-sm text-[var(--text)] truncate">{run.prompt}</p>
              <p className="font-mono text-xs text-[var(--muted)] mt-0.5">
                {new Date(run.createdAt).toLocaleString()} · {run.model}
              </p>
            </div>
          )
        })}
      </div>

      {/* Inline console */}
      {selectedId && (
        <div className="flex-1 overflow-hidden border-t border-[var(--border)]">
          <RunConsole runId={selectedId} />
        </div>
      )}
    </div>
  )
}
