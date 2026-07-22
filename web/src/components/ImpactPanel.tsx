import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RunImpactPayload } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { onWsMessage } from '../lib/ws'

const RISK_CLS: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-green/15 text-green',
  medium: 'bg-amber/15 text-amber',
  high: 'bg-red/15 text-red',
}

export default function ImpactPanel({ runId, projectId }: { runId: string; projectId: string | null }) {
  const [open, setOpen] = useState(true)
  const { data } = useQuery<RunImpactPayload>({
    queryKey: ['run-impact', runId],
    queryFn: () => api.runs.impact(runId),
  })
  const build = useMutation({
    // The existing graph-build wrapper (web/src/lib/api.ts — the Knowledge
    // Graph tab's). CONFIRMED name: graphBuild.
    mutationFn: () => api.projects.graphBuild(projectId!),
  })
  // graph/build is fire-and-forget (202; completion arrives over the WS
  // graph_update channel — KnowledgeGraphTab convention). A graph_update for
  // THIS project refetches the impact payload so the CTA resolves to the real
  // panel, and resets the mutation so a FAILED build re-enables the button
  // instead of locking on "Indexing…" forever (review-caught HIGH).
  const qc = useQueryClient()
  const resetBuild = build.reset
  useEffect(() => {
    if (!projectId) return
    return onWsMessage((msg) => {
      if (msg.type === 'graph_update' && msg.projectId === projectId) {
        qc.invalidateQueries({ queryKey: ['run-impact', runId] })
        resetBuild()
      }
    })
  }, [projectId, runId, qc, resetBuild])
  if (!data) return null
  if (!data.indexed) {
    return (
      <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-[var(--glass-tier-border)] bg-[var(--glass-3)] px-3 py-2" data-testid="impact-cta">
        <span className="text-xs text-muted">Impact map needs a code index.</span>
        {projectId && (
          <button
            onClick={() => build.mutate()}
            disabled={build.isPending || build.isSuccess}
            className="text-xs px-2 py-0.5 rounded font-semibold bg-accent/15 text-accent-hover hover:bg-accent/25 disabled:opacity-40"
          >
            {build.isPending || build.isSuccess ? 'Indexing…' : 'Index this project'}
          </button>
        )}
      </div>
    )
  }
  if (data.files.length === 0) return null
  return (
    <div className="mx-4 mt-3 rounded-lg border border-border" data-testid="impact-panel">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Impact</span>
        {data.risk && (
          <span data-testid="impact-risk" className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase', RISK_CLS[data.risk])}>
            {data.risk} risk
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--glass-3)] border border-[var(--glass-tier-border)] text-muted font-medium">
          {data.totalSymbols} symbols · {data.totalDependents} dependents
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 space-y-2 overflow-x-auto">
          {data.files.filter(f => f.symbols.length > 0).map(f => (
            <div key={f.file}>
              <p className="text-xs font-medium text-text truncate">{f.file}</p>
              <div className="flex flex-wrap gap-1 pt-1">
                {f.symbols.map(s => (
                  <span key={s.id}
                    className={cn('text-[10px] px-1.5 py-0.5 rounded border font-mono',
                      s.dependents >= 10 ? 'border-red/50 text-red'
                      : s.dependents >= 3 ? 'border-amber/50 text-amber'
                      : 'border-border text-muted')}>
                    {s.name} · {s.dependents}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
