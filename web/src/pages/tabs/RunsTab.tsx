import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../../lib/api'
import { onWsMessage } from '../../lib/ws'
import { cn } from '../../lib/cn'
import { cleanRunPrompt } from '../../lib/prompt'
import { runDuration } from '../../lib/format-metrics'
import RunConsole from '../../components/RunConsole'
import { EmptyState } from '../../ui/EmptyState'
import { StatusPill } from '../../ui/StatusPill'
import { Row } from '../../ui/Row'

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
            <Row
              key={run.id}
              testid="run-row"
              selected={isSelected}
              onClick={() => setSelectedId(isSelected ? null : run.id)}
              leading={<StatusPill status={run.status} />}
              title={cleanRunPrompt(run.prompt)}
              sub={<span className="mono tabular-nums">{new Date(run.createdAt).toLocaleString()} · {run.model}</span>}
              meta={
                <span className="flex flex-col items-end">
                  <span>${run.costUsd.toFixed(4)}</span>
                  {runDuration(run) && <span data-testid="run-duration">{runDuration(run)}</span>}
                </span>
              }
            />
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
