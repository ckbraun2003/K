import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run, AgentEvent, WsMessage, NamedWorkflow } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'
import { mergeEvents } from '../components/RunConsole'
import { eventsToWorkflowTree } from '../lib/workflow'
import WorkflowChecklist from '../components/WorkflowChecklist'
import RunTree from '../components/RunTree'

type Tab = 'defined' | 'run'

/** The role sequence as a compact chain string (e.g. "orchestrator → implementer → …").
 *  Pure + exported for unit-testing. */
export function roleChain(roles: NamedWorkflow['roles']): string {
  return roles.map(r => r.id).join(' → ')
}

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

/** The Definitions list + preview (the operator-editable named workflow templates). One
 *  batched query; a selected row previews its role chain + cross-project flag and opens the
 *  editor. Matches the ui-demo Workflows screen (list left, preview right). */
function DefinitionsSection() {
  const { data: defs, isLoading, isError } = useQuery<NamedWorkflow[]>({
    queryKey: ['workflow-defs'],
    queryFn: () => api.workflows.list(),
  })

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  // Default the selection to the first definition once the list arrives.
  useEffect(() => {
    if (!selectedId && defs && defs.length > 0) setSelectedId(defs[0].id)
  }, [defs, selectedId])

  if (isLoading) return <p className="text-xs italic text-[var(--muted)]">Loading definitions…</p>
  if (isError) return <p className="text-xs italic text-[var(--red)]">Failed to load workflow definitions.</p>
  if (!defs || defs.length === 0) {
    return (
      <p className="text-xs italic text-[var(--muted)]" data-testid="workflow-defs-empty">
        No workflow definitions seeded yet.
      </p>
    )
  }

  const selected = defs.find(d => d.id === selectedId) ?? defs[0]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left — the definitions list. */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Definitions</h2>
        <ul className="space-y-1">
          {defs.map(def => (
            <li key={def.id}>
              <button
                type="button"
                onClick={() => setSelectedId(def.id)}
                data-testid={`workflow-def-row-${def.id}`}
                aria-pressed={def.id === selected.id}
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                  def.id === selected.id
                    ? 'border-[color:rgba(56,189,248,0.45)] bg-[var(--raised)]'
                    : 'border-[var(--border)] hover:border-[color:rgba(56,189,248,0.25)]',
                )}
              >
                <span className="block truncate text-sm font-semibold text-[var(--text)]">{def.name}</span>
                <span className="mono mt-0.5 block truncate text-[11px] text-[var(--muted)]">
                  {roleChain(def.roles)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Right — preview of the selected definition. */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="workflow-def-preview">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{selected.name}</h2>
          {selected.crossProject && (
            <span className="flex-shrink-0 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]">
              cross-project
            </span>
          )}
        </div>

        {/* Role chain as a sequential pipeline of chips. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.roles.map((role, i) => (
            <span key={role.id} className="flex items-center gap-1.5">
              <span className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-[11px] font-semibold text-[var(--text)]">
                {role.label}
              </span>
              {i < selected.roles.length - 1 && <span className="text-[var(--muted)]">→</span>}
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={() => navigate('workflow-detail', selected.id)}
          data-testid="workflow-def-open"
          className="mt-4 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
        >
          Open
        </button>
      </section>
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
            The named workflow templates. Select a definition to preview its role chain, or open it to edit.
          </p>
          <DefinitionsSection />
        </section>
      ) : (
        <section>
          <RunTreeSection initialRunId={runId} />
        </section>
      )}
    </div>
  )
}
