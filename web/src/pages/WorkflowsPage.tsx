import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run, AgentEvent, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'
import { mergeEvents } from '../components/RunConsole'
import { eventsToWorkflowTree } from '../lib/workflow'
import WorkflowDiagram from '../components/WorkflowDiagram'
import WorkflowChecklist from '../components/WorkflowChecklist'
import RunTree from '../components/RunTree'

type Tab = 'defined' | 'run'

// Non-terminal run statuses — while the run is live we poll the checklist so the
// orchestrator's status-writes surface without a dedicated WS channel.
const LIVE_STATUSES = new Set(['queued', 'running', 'awaiting_input'])

/** Short, readable label for a run in the picker. */
function runOptionLabel(run: Run): string {
  const prompt = run.prompt.replace(/\s+/g, ' ').trim()
  const head = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt || '(no prompt)'
  return `${head}  ·  ${run.status}`
}

/** The live runtime tree section: pick a run, build + live-update its tree. */
function RunTreeSection({ initialRunId }: { initialRunId?: string }) {
  const qc = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initialRunId)
  const [events, setEvents] = useState<AgentEvent[]>([])

  const { data: runs } = useQuery<Run[]>({
    queryKey: ['runs', 'workflows-picker'],
    queryFn: () => api.runs.list({ limit: 50 }),
  })

  // Honour back/forward deep-links (#/workflows/:runId).
  useEffect(() => {
    if (initialRunId) setSelectedRunId(initialRunId)
  }, [initialRunId])

  // Default to the most recent run once the list arrives (only if none chosen).
  useEffect(() => {
    if (!selectedRunId && runs && runs.length > 0) setSelectedRunId(runs[0].id)
  }, [runs, selectedRunId])

  const { data: run } = useQuery<Run>({
    queryKey: ['run', selectedRunId],
    queryFn: () => api.runs.get(selectedRunId as string),
    enabled: !!selectedRunId,
  })

  // Backfill history + append live events via WS — mirrors RunConsole's effect:
  // reset on run change, dedupe-by-id + seq-sort through mergeEvents.
  useEffect(() => {
    setEvents([])
    if (!selectedRunId) return
    let cancelled = false
    const unsub = onWsMessage((msg: WsMessage) => {
      if (msg.type === 'event' && msg.event.runId === selectedRunId) {
        setEvents(prev => mergeEvents(prev, [msg.event]))
      }
      if (msg.type === 'run_update' && msg.run.id === selectedRunId) {
        qc.setQueryData(['run', selectedRunId], msg.run)
      }
    })
    api.runs
      .events(selectedRunId)
      .then(history => {
        if (!cancelled) setEvents(prev => mergeEvents(history, prev))
      })
      .catch(() => { /* live stream still works without backfill */ })
    return () => { cancelled = true; unsub() }
  }, [selectedRunId, qc])

  const tree = useMemo(() => eventsToWorkflowTree(events, run), [events, run])

  // Explicit progress checklist (kstore status-writes). Polls while the run is
  // live; one final fetch once it terminates. Absent for non-workflow runs.
  const { data: wf } = useQuery({
    queryKey: ['workflow-steps', selectedRunId],
    queryFn: () => api.runs.workflowSteps(selectedRunId as string),
    enabled: !!selectedRunId,
    refetchInterval: run && LIVE_STATUSES.has(run.status) ? 4000 : false,
  })

  function pick(id: string) {
    setSelectedRunId(id)
    navigate('workflows', id)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label htmlFor="wf-run-picker" className="text-xs text-[var(--muted)]">
          Run
        </label>
        <select
          id="wf-run-picker"
          value={selectedRunId ?? ''}
          onChange={e => pick(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.45)]"
        >
          {!selectedRunId && <option value="">Select a run…</option>}
          {(runs ?? []).map(r => (
            <option key={r.id} value={r.id}>
              {runOptionLabel(r)}
            </option>
          ))}
        </select>
      </div>

      {selectedRunId ? (
        <div className="space-y-4">
          {/* Explicit checklist (only for delegation-workflow runs) above the
              inferred runtime tree, which always stays. */}
          {wf?.workflowRun && <WorkflowChecklist steps={wf.steps} workflowRun={wf.workflowRun} />}
          {/* key by run id so RunTree remounts (resetting its internal node
              selection) when the operator switches runs — WorkflowsPage stays
              mounted across hash changes, so without this the prior run's
              selected-child id would linger and nothing would show as selected. */}
          <RunTree key={selectedRunId} tree={tree} />
        </div>
      ) : (
        <p className="text-xs italic text-[var(--muted)]">
          {runs && runs.length === 0 ? 'No runs yet.' : 'Select a run to view its sub-agent tree.'}
        </p>
      )}
    </div>
  )
}

export default function WorkflowsPage({ runId }: { runId?: string }) {
  // Deep-linked to a run → open the live tree; otherwise show the defined loop.
  const [tab, setTab] = useState<Tab>(runId ? 'run' : 'defined')

  // The page stays mounted across hash changes, so a later #/workflows → #/workflows/:id
  // navigation only updates the prop — switch to the run tree so the deep link shows.
  useEffect(() => {
    if (runId) setTab('run')
  }, [runId])

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Workflows</h1>
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-0.5">
          {(
            [
              ['defined', 'Defined workflow'],
              ['run', 'Run tree'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors duration-150',
                tab === id
                  ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--text)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'defined' ? (
        <section>
          <p className="mb-4 max-w-2xl text-xs text-[var(--muted)]">
            The harness code-wave delegation loop. Select a role to read its responsibility.
          </p>
          <WorkflowDiagram />
        </section>
      ) : (
        <section>
          <RunTreeSection initialRunId={runId} />
        </section>
      )}
    </div>
  )
}
