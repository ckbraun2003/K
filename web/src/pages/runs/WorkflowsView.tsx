import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import type { Run, AgentEvent, WsMessage, NamedWorkflow, WorkflowRun, Project, ProjectTask } from '@k/shared'
import { api, type NamedWorkflowPatch } from '../../lib/api'
import { navigate } from '../../lib/route'
import { onWsMessage } from '../../lib/ws'
import { cn } from '../../lib/cn'
import { useFocusTrap } from '../../lib/useFocusTrap'
import { mergeEvents } from '../../components/RunConsole'
import { eventsToWorkflowTree } from '../../lib/workflow'
import WorkflowChecklist from '../../components/WorkflowChecklist'
import RunTree from '../../components/RunTree'
import AutoTextarea from '../../components/AutoTextarea'
import Toast from '../../components/Toast'
import SegControl from '../../components/SegControl'

type Tab = 'defined' | 'run'

/** The role sequence as a compact chain string (e.g. "orchestrator → implementer → …").
 *  Pure + exported for unit-testing. */
export function roleChain(roles: NamedWorkflow['roles']): string {
  return roles.map(r => r.id).join(' → ')
}

// Non-terminal run statuses — while the run is live we poll the checklist so the
// orchestrator's status-writes surface without a dedicated WS channel.
// P2 E-02: awaiting_plan is non-terminal — keep polling the checklist while parked on plan review.
const LIVE_STATUSES = new Set(['queued', 'running', 'awaiting_input', 'awaiting_plan'])

/** Short, readable label for a run in the picker. */
function runOptionLabel(run: Run): string {
  const prompt = run.prompt.replace(/\s+/g, ' ').trim()
  const head = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt || '(no prompt)'
  return `${head}  ·  ${run.status}`
}

/**
 * Picker identity filter (C2): the Workflows run-picker defaults to runs that were
 * actually WORKFLOW-DISPATCHED (their id appears as a workflow_runs.run_id), not
 * every run in the fleet — `showAll` widens back to everything. Pure + exported
 * for unit-testing.
 */
export function filterPickerRuns(
  runs: Run[],
  workflowRunIds: Set<string>,
  showAll: boolean,
): Run[] {
  return showAll ? runs : runs.filter(r => workflowRunIds.has(r.id))
}

/** The live runtime tree section: pick a run, build + live-update its tree. */
function RunTreeSection({ initialRunId }: { initialRunId?: string }) {
  const qc = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initialRunId)
  const [events, setEvents] = useState<AgentEvent[]>([])
  // Default WORKFLOW-ONLY — except deep-linked: the deep-linked run may not be a
  // workflow dispatch, and filtering it out of its own deep link would be absurd.
  const [showAll, setShowAll] = useState(!!initialRunId)

  const { data: runs } = useQuery<Run[]>({
    queryKey: ['runs', 'workflows-picker'],
    queryFn: () => api.runs.list({ limit: 50 }),
  })
  // Which runs were workflow-dispatched — the workflow_runs table is the identity
  // source (run_id is null until the dispatch reached a run, hence the filter).
  const { data: workflowRuns = [] } = useQuery<WorkflowRun[]>({
    queryKey: ['workflow-runs'],
    queryFn: () => api.workflows.runs(),
  })
  const workflowRunIds = useMemo(
    () => new Set(workflowRuns.map(r => r.runId).filter((id): id is string => id != null)),
    [workflowRuns],
  )
  const pickerRuns = useMemo(
    () => filterPickerRuns(runs ?? [], workflowRunIds, showAll),
    [runs, workflowRunIds, showAll],
  )

  // Honour back/forward deep-links (#/workflows/:runId) — widen to All runs so the
  // deep-linked run is always present in its own picker.
  useEffect(() => {
    if (initialRunId) {
      setSelectedRunId(initialRunId)
      setShowAll(true)
    }
  }, [initialRunId])

  // Default to the most recent FILTERED run once the list arrives (only if none
  // chosen) — the workflow-only default must not select a filtered-out run.
  useEffect(() => {
    if (!selectedRunId && pickerRuns.length > 0) setSelectedRunId(pickerRuns[0].id)
  }, [pickerRuns, selectedRunId])

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

  // Update the tree IN PLACE — WorkflowsView stays mounted so the operator can browse
  // any run's sub-agent tree without leaving the view. (navigate('runs', id) would set
  // #/runs/<id>, which RunsPage renders as the plain run CONSOLE — unmounting this view.
  // Deep-linking a specific run to the console is the redirect contract's job, not the
  // in-view picker's; see route-redirects.test.ts '#/workflows/<runId> → that run'.)
  function pick(id: string) {
    setSelectedRunId(id)
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
          {pickerRuns.map(r => (
            <option key={r.id} value={r.id}>
              {runOptionLabel(r)}
            </option>
          ))}
        </select>
        {/* Widen the picker from workflow-dispatched runs to every run. */}
        <button
          type="button"
          data-testid="wf-picker-all"
          aria-pressed={showAll}
          onClick={() => setShowAll(s => !s)}
          className={cn(
            'flex-shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors',
            showAll
              ? 'border-[color:rgba(56,189,248,0.45)] text-[var(--accent-hover)]'
              : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]',
          )}
        >
          All runs
        </button>
      </div>

      {pickerRuns.length === 0 && !showAll && (runs?.length ?? 0) > 0 && (
        <p className="text-xs italic text-[var(--muted)]" data-testid="wf-picker-empty">
          No workflow-dispatched runs yet — toggle All runs.
        </p>
      )}

      {selectedRunId ? (
        <div className="space-y-4">
          {/* Explicit checklist (only for delegation-workflow runs) above the
              inferred runtime tree, which always stays. */}
          {wf?.workflowRun && <WorkflowChecklist steps={wf.steps} workflowRun={wf.workflowRun} />}
          {/* key by run id so RunTree remounts (resetting its internal node
              selection) when the operator switches runs — WorkflowsView stays
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
          onClick={() => navigate('agents', 'pipelines', selected.id)}
          data-testid="workflow-def-open"
          className="mt-4 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
        >
          Open
        </button>
      </section>
    </div>
  )
}

/** LIST mode — the Definitions list + Run-tree behind the canonical SegControl (former
 *  WorkflowsPage body). Takes no runId: the Run tree opens fresh (initialRunId undefined). */
function WorkflowsList() {
  const [tab, setTab] = useState<Tab>('defined')

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Workflows</h1>
        <SegControl<'defined' | 'run'>
          ariaLabel="Workflows view"
          options={[{ label: 'Defined workflow', value: 'defined' }, { label: 'Run tree', value: 'run' }]}
          value={tab}
          onChange={setTab}
        />
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
          <RunTreeSection initialRunId={undefined} />
        </section>
      )}
    </div>
  )
}

/**
 * The run-this-workflow dialog: pick a project → check its OPEN tasks → fire. A
 * local modal mirroring ConfirmDialog's overlay/dialog styling + focus/esc handling
 * (same useFocusTrap; ConfirmDialog itself fits a one-button confirm, not a two-step
 * form). Dispatch errors surface INSIDE the dialog; success is reported up via
 * `onDispatched` so the page can close + toast with the run link.
 */
function RunWorkflowDialog({
  open,
  workflowId,
  onClose,
  onDispatched,
}: {
  open: boolean
  workflowId: string
  onClose: () => void
  onDispatched: (runId: string) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const qc = useQueryClient()
  const [projectId, setProjectId] = useState('')
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())

  useFocusTrap(cardRef, open)

  const { data: projects, isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    // The closure (not a bare method reference) avoids eagerly dereferencing
    // api.projects while the dialog mounts closed; `enabled: open` is what
    // actually gates the fetch.
    queryFn: () => api.projects.list(),
    enabled: open,
  })
  // Same ['tasks', projectId] cache key as TasksTab — one resource, one cache
  // entry, so either surface's invalidation refreshes both.
  const { data: tasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.projects.tasks.list(projectId),
    enabled: open && projectId !== '',
  })
  // Only OPEN tasks are dispatchable — in_progress ones are already locked by
  // another workflow run and done ones are finished.
  const openTasks = tasks.filter(t => t.status === 'open')

  const dispatch = useMutation({
    mutationFn: () => api.projects.tasks.dispatchWorkflow(projectId, [...checked], workflowId),
    onSuccess: r => onDispatched(r.runId),
    // The dispatch just locked the selected tasks in_progress and inserted a
    // workflow_runs row — refresh both caches (onSettled so a failure also
    // re-syncs; mirrors TasksTab's own dispatch mutation). Without this, the
    // global 5s staleTime re-offers a just-dispatched task as "open" on reopen.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      void qc.invalidateQueries({ queryKey: ['workflow-runs'] })
    },
    // Not swallowed — dispatch.error renders inside the dialog below.
  })

  // Reset the form each time the dialog opens (a stale selection must not survive).
  useEffect(() => {
    if (open) {
      setProjectId('')
      setChecked(new Set())
      dispatch.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape cancels — global listener while open, mirroring ConfirmDialog. Ignored
  // while the dispatch is in flight: closing then would render a failure into a
  // closed dialog (reopening resets it), leaving the operator with no visible error.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !dispatch.isPending) { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, dispatch.isPending])

  function toggleTask(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          {/* Backdrop click cancels — but not mid-dispatch (same rationale as Esc). */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => { if (!dispatch.isPending) onClose() }}
          />
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            data-testid="workflow-run-dialog"
            className="relative w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
            initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <h3 id={headingId} className="text-sm font-semibold text-[var(--text)]">
              Run this workflow
            </h3>

            {/* Step 1 — project. */}
            <div className="mt-3">
              <label className="mb-1 block text-[11px] text-[var(--muted)]">Project</label>
              {projects && projects.length === 0 ? (
                <p className="text-xs italic text-[var(--muted)]">No projects registered.</p>
              ) : (
                <select
                  data-testid="workflow-run-project"
                  aria-label="Project"
                  disabled={projectsLoading}
                  value={projectId}
                  onChange={e => { setProjectId(e.target.value); setChecked(new Set()) }}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50"
                >
                  <option value="">{projectsLoading ? 'loading projects…' : 'Select a project…'}</option>
                  {(projects ?? []).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Step 2 — the project's OPEN tasks. */}
            {projectId !== '' && (
              <div className="mt-3">
                <label className="mb-1 block text-[11px] text-[var(--muted)]">Open tasks</label>
                {openTasks.length === 0 ? (
                  <p className="text-xs italic text-[var(--muted)]">No open tasks in this project.</p>
                ) : (
                  <ul className="max-h-48 space-y-1 overflow-y-auto">
                    {openTasks.map(t => (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1.5 text-xs text-[var(--text)]">
                          <input
                            type="checkbox"
                            data-testid={`workflow-run-task-${t.id}`}
                            checked={checked.has(t.id)}
                            onChange={() => toggleTask(t.id)}
                            className="flex-shrink-0 accent-[var(--accent)]"
                          />
                          <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {dispatch.isError && (
              <p data-testid="workflow-run-error" className="mt-3 text-xs text-[var(--red)]">
                {(dispatch.error as Error).message}
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                disabled={dispatch.isPending}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                data-testid="workflow-run-fire"
                disabled={checked.size === 0 || dispatch.isPending}
                onClick={() => dispatch.mutate()}
                className="rounded-lg border border-accent/50 bg-accent/20 px-4 py-1.5 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:bg-accent/30 disabled:opacity-50"
              >
                {dispatch.isPending ? '…' : 'Run'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function NotFound({ id }: { id?: string }) {
  return (
    <div className="h-full overflow-y-auto p-5">
      <button
        type="button"
        onClick={() => navigate('runs', 'workflows')}
        className="text-[11px] text-[var(--accent-hover)] hover:underline"
      >
        ← Workflows
      </button>
      <div
        className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
        data-testid="workflow-detail-notfound"
      >
        <p className="text-sm font-semibold text-[var(--text)]">Workflow not found</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {id ? `No workflow definition with id "${id}".` : 'No workflow selected.'}
        </p>
      </div>
    </div>
  )
}

/**
 * EDITOR mode (P5.3b → C2) — a single named workflow template's editor plus the
 * "Run this workflow" launcher (former WorkflowDetailPage body). ONE batched query
 * loads the NamedWorkflow; the role graph is read-only (roles editing is deferred),
 * while the name, prompt scaffold, and cross-project flag are editable via
 * api.workflows.update (read-merge-write server-side). The launcher dispatches THIS
 * template's scaffold over a project's open tasks (POST tasks/dispatch + workflowId).
 */
function WorkflowEditor({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const [nameDraft, setNameDraft] = useState('')
  const [scaffoldDraft, setScaffoldDraft] = useState('')
  // "Run this workflow" launcher state: the dialog + the just-dispatched run id
  // (the success toast's View-run target; null = no toast).
  const [runOpen, setRunOpen] = useState(false)
  const [dispatchedRunId, setDispatchedRunId] = useState<string | null>(null)
  // Which workflow id the drafts were last seeded from — so a background refetch
  // (refetchOnWindowFocus) that returns a new `detail` object for the SAME workflow does
  // not clobber the operator's unsaved edits. Only a genuine workflow switch re-seeds.
  const seededId = useRef<string | undefined>(undefined)

  const { data: detail, isLoading, isError } = useQuery<NamedWorkflow>({
    queryKey: ['workflow-def', id],
    queryFn: () => api.workflows.get(id!),
    enabled: !!id,
  })

  // Seed the editable drafts once per workflow id (first load / a switch), NOT on every
  // `detail` ref change — a refetch for the same id must not discard unsaved edits.
  useEffect(() => {
    if (detail && seededId.current !== detail.id) {
      seededId.current = detail.id
      setNameDraft(detail.name)
      setScaffoldDraft(detail.promptScaffold)
    }
  }, [detail])

  const mutation = useMutation({
    mutationFn: (patch: NamedWorkflowPatch) => api.workflows.update(id!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-def', id] })
      queryClient.invalidateQueries({ queryKey: ['workflow-defs'] })
    },
    // Do NOT swallow — the server message is surfaced in the banner below.
  })

  if (!id || isError) return <NotFound id={id} />
  if (isLoading || !detail) {
    return (
      <div className="h-full overflow-y-auto p-5">
        <p className="text-xs italic text-[var(--muted)]">Loading workflow…</p>
      </div>
    )
  }

  const errorMsg = mutation.isError ? (mutation.error as Error).message : null
  const nameDirty = nameDraft.trim() !== '' && nameDraft.trim() !== detail.name
  const scaffoldDirty = scaffoldDraft !== detail.promptScaffold

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('runs', 'workflows')}
          className="text-[11px] text-[var(--accent-hover)] hover:underline"
        >
          ← Workflows
        </button>
        <h1 className="text-sm font-semibold text-[var(--text)]">{detail.name}</h1>
        {detail.crossProject && (
          <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]">
            cross-project
          </span>
        )}
        <button
          type="button"
          data-testid="workflow-run-open"
          onClick={() => setRunOpen(true)}
          className="ml-auto rounded-lg border border-accent/50 bg-accent/20 px-3 py-1.5 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:bg-accent/30"
        >
          ⚡ Run this workflow
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — role graph (read-only) + name + cross-project. */}
        <section className="space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Role graph</h2>
            {detail.roles.length === 0 ? (
              <p className="text-xs italic text-[var(--muted)]">No roles defined.</p>
            ) : (
              <ol className="space-y-1">
                {detail.roles.map((role, i) => (
                  <li
                    key={role.id}
                    data-testid={`workflow-role-${role.id}`}
                    className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold text-[var(--muted)]">{i + 1}</span>
                      <span className="text-xs font-semibold text-[var(--text)]">{role.label}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">{role.description}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Name</h2>
            <form
              className="flex gap-2"
              onSubmit={e => {
                e.preventDefault()
                if (nameDirty) mutation.mutate({ name: nameDraft.trim() })
              }}
            >
              <input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                data-testid="workflow-detail-name"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
              <button
                type="submit"
                disabled={mutation.isPending || !nameDirty}
                className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
              >
                Rename
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Cross-project</h2>
                <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                  Reserved flag — may this workflow reach outside the current project? Execution deferred.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={detail.crossProject}
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ crossProject: !detail.crossProject })}
                data-testid="workflow-detail-crossproject"
                className={
                  detail.crossProject
                    ? 'flex-shrink-0 rounded-full border border-[var(--green)]/50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--green)] disabled:opacity-50'
                    : 'flex-shrink-0 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] disabled:opacity-50'
                }
              >
                {detail.crossProject ? 'on' : 'off'}
              </button>
            </div>
          </div>
        </section>

        {/* Right — prompt scaffold editor. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Prompt scaffold</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                <span className="mono">{'{{CHECKLIST}}'}</span> is replaced with the numbered todo list at dispatch.
              </p>
            </div>
            <button
              type="button"
              disabled={mutation.isPending || !scaffoldDirty}
              onClick={() => mutation.mutate({ promptScaffold: scaffoldDraft })}
              data-testid="workflow-detail-save"
              className="flex-shrink-0 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-4 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <AutoTextarea
            value={scaffoldDraft}
            onChange={e => setScaffoldDraft(e.target.value)}
            maxHeight={520}
            data-testid="workflow-detail-scaffold"
            className="mono w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.45)]"
          />
        </section>
      </div>

      {errorMsg && (
        <p
          data-testid="workflow-detail-error"
          className="mt-3 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
        >
          {errorMsg}
        </p>
      )}

      <RunWorkflowDialog
        open={runOpen}
        workflowId={detail.id}
        onClose={() => setRunOpen(false)}
        onDispatched={runId => { setRunOpen(false); setDispatchedRunId(runId) }}
      />

      {/* Dispatch success — close the dialog and link into the started run. */}
      <Toast
        open={dispatchedRunId !== null}
        testid="workflow-run-toast"
        message={<>Workflow dispatched</>}
        action={{
          label: 'View run →',
          testid: 'workflow-run-view',
          onClick: () => { if (dispatchedRunId) navigate('runs', dispatchedRunId) },
        }}
        onDismiss={() => setDispatchedRunId(null)}
      />
    </div>
  )
}

/**
 * Workflows folded into Runs (P4 C1): with a `defId` this is the single-template EDITOR
 * (former WorkflowDetailPage); without one it is the LIST (former WorkflowsPage — the
 * Definitions list + Run tree behind a SegControl).
 */
export default function WorkflowsView({ defId }: { defId?: string }): JSX.Element {
  if (defId) return <WorkflowEditor id={defId} />
  return <WorkflowsList />
}
