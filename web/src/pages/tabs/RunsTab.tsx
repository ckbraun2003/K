import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../../lib/api'
import { onWsMessage } from '../../lib/ws'
import { cn } from '../../lib/cn'
import { runStatusMeta } from '../../lib/status'
import RunConsole from '../../components/RunConsole'
import { EmptyState } from '../../ui/EmptyState'

interface Props {
  projectId: string
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
      <div className={cn('flex-shrink-0 overflow-y-auto border-b border-border', selectedId ? 'max-h-64' : 'flex-1')}>
        {runs.length === 0 && (
          <EmptyState
            icon="runs"
            headline="No runs for this project yet."
            hint="Use the Tasks tab to dispatch an agent run."
          />
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
                'w-full text-left px-4 py-3 border-b border-border hover:bg-surface transition-colors cursor-pointer',
                isSelected && 'bg-surface border-l-2 border-l-accent'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', runStatusMeta(run.status).dot)} />
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', runStatusMeta(run.status).badge)}>
                  {runStatusMeta(run.status).label}
                </span>
                <span className="mono text-xs text-muted ml-auto">
                  ${run.costUsd.toFixed(4)}
                </span>
              </div>
              <p className="text-sm text-text truncate">{run.prompt}</p>
              <p className="mono text-xs text-muted mt-0.5">
                {new Date(run.createdAt).toLocaleString()} · {run.model}
              </p>
            </div>
          )
        })}
      </div>

      {/* Inline console */}
      {selectedId && (
        <div className="flex-1 overflow-hidden border-t border-border">
          <RunConsole runId={selectedId} />
        </div>
      )}
    </div>
  )
}
