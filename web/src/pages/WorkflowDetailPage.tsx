import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import type { NamedWorkflow, Project, ProjectTask } from '@k/shared'
import { api, type NamedWorkflowPatch } from '../lib/api'
import { navigate } from '../lib/route'
import { useFocusTrap } from '../lib/useFocusTrap'
import AutoTextarea from '../components/AutoTextarea'
import Toast from '../components/Toast'

/**
 * Workflow detail (P5.3b → C2) — a single named workflow template's editor plus the
 * "Run this workflow" launcher. ONE batched query loads the NamedWorkflow; the role
 * graph is read-only (roles editing is deferred), while the name, prompt scaffold,
 * and cross-project flag are editable via api.workflows.update (read-merge-write
 * server-side). The launcher dispatches THIS template's scaffold over a project's
 * open tasks (POST tasks/dispatch + workflowId). Mirrors OrchestratorDetailPage's
 * shape (back link, NotFound, mutation + error banner).
 */

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
        onClick={() => navigate('workflows')}
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

export default function WorkflowDetailPage({ id }: { id?: string }) {
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
          onClick={() => navigate('workflows')}
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
