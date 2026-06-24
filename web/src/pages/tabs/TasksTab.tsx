import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProjectTask } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { navigate } from '../../lib/route'
import Toast from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'

interface Props {
  projectId: string
}

const STATUS_CYCLE: Record<ProjectTask['status'], ProjectTask['status']> = {
  open:        'in_progress',
  in_progress: 'done',
  done:        'open',
}

const STATUS_DOT: Record<ProjectTask['status'], string> = {
  open:        'bg-[var(--amber)]',
  in_progress: 'bg-[var(--accent)]',
  done:        'bg-[var(--green)]',
}

const STATUS_LABEL: Record<ProjectTask['status'], string> = {
  open:        'open',
  in_progress: 'in progress',
  done:        'done',
}

function formatTimeAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export default function TasksTab({ projectId }: Props) {
  const qc = useQueryClient()
  const [newTitle, setNewTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [pendingDispatchIds, setPendingDispatchIds] = useState<Set<string>>(new Set())
  // Multi-select for the "run delegation workflow" path (distinct from the per-row quick dispatch).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Success toast pointing at the orchestrator run the workflow dispatch created.
  const [dispatched, setDispatched] = useState<{ runId: string; count: number } | null>(null)
  // Task pending a delete confirm.
  const [deletingTask, setDeletingTask] = useState<ProjectTask | null>(null)

  const { data: tasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.projects.tasks.list(projectId),
    refetchInterval: 10_000,
  })

  // Prune ghost ids (deleted/synced-away tasks) from the selection after a refetch
  // so the toast count and dispatch payload never reference tasks that no longer exist.
  useEffect(() => {
    if (!tasks.length) return
    const valid = new Set(tasks.map(t => t.id))
    setSelectedIds(s => {
      const pruned = new Set([...s].filter(id => valid.has(id)))
      return pruned.size === s.size ? s : pruned
    })
  }, [tasks])

  function toggleSelect(id: string) {
    setSelectedIds(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  function clearSelection() {
    setSelectedIds(new Set())
  }
  const allSelected = tasks.length > 0 && tasks.every(t => selectedIds.has(t.id))
  const someSelected = selectedIds.size > 0 && !allSelected
  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(tasks.map(t => t.id)))
  }

  const createTask = useMutation({
    mutationFn: (title: string) => api.projects.tasks.create(projectId, title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      setNewTitle('')
      inputRef.current?.focus()
    },
  })

  const updateStatus = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: ProjectTask['status'] }) =>
      api.projects.tasks.updateStatus(projectId, taskId, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const syncIssues = useMutation({
    mutationFn: () => api.projects.tasks.sync(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
  })

  const deleteTask = useMutation({
    mutationFn: (taskId: string) => api.projects.tasks.delete(projectId, taskId),
    onSuccess: (_d, taskId) => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      // Drop the removed id from any pending selection so the count/payload stay honest.
      setSelectedIds(s => {
        if (!s.has(taskId)) return s
        const n = new Set(s); n.delete(taskId); return n
      })
      setDeletingTask(null)
    },
  })
  function closeDeleteTask() { setDeletingTask(null); deleteTask.reset() }

  const dispatchAgent = useMutation({
    mutationFn: (task: ProjectTask) =>
      api.runs.start(task.title, { projectId }),
    onMutate: (task) => setPendingDispatchIds(s => new Set(s).add(task.id)),
    onSettled: (_d, _e, task) => setPendingDispatchIds(s => { const n = new Set(s); n.delete(task.id); return n }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', 'project', projectId] })
    },
  })

  const dispatchWorkflow = useMutation({
    mutationFn: (ids: string[]) => api.projects.tasks.dispatchWorkflow(projectId, ids),
    onSuccess: (data, ids) => {
      setDispatched({ runId: data.runId, count: ids.length })
      setSelectedIds(new Set())
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }), // heal even on error (fix m4)
  })

  function handleAdd() {
    const t = newTitle.trim()
    if (!t) return
    createTask.mutate(t)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAdd()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Add task input */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
        <input
          ref={inputRef}
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="New task title…"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={handleAdd}
          disabled={!newTitle.trim() || createTask.isPending}
          className="rounded-control bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          {createTask.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {/* Selection bar: select-all + clear */}
      {tasks.length > 0 && (
        <div className="flex-shrink-0 px-4 py-1.5 border-b border-[var(--border)] flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="tasks-select-all"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = someSelected }}
              onChange={toggleSelectAll}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
            />
            Select all
          </label>
          {selectedIds.size > 0 && (
            <span className="text-[11px] text-[var(--muted)]">
              {selectedIds.size} selected ·{' '}
              <button
                data-testid="tasks-header-clear"
                onClick={clearSelection}
                className="text-[var(--accent)] hover:underline"
              >
                clear
              </button>
            </span>
          )}
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
            No tasks yet. Add one above.
          </div>
        )}
        {tasks.map(task => (
          <div
            key={task.id}
            className="group flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
          >
            {/* Multi-select checkbox (workflow delegation path) */}
            <input
              type="checkbox"
              data-testid={`task-select-${task.id}`}
              checked={selectedIds.has(task.id)}
              onChange={() => toggleSelect(task.id)}
              aria-label={`Select task: ${task.title}`}
              className="flex-shrink-0 h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
            />

            {/* Status toggle */}
            <button
              onClick={() => updateStatus.mutate({ taskId: task.id, status: STATUS_CYCLE[task.status] })}
              title={`Status: ${STATUS_LABEL[task.status]} — click to advance`}
              className="flex-shrink-0 flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
            >
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[task.status])} />
              <span className="text-[var(--muted)]">{STATUS_LABEL[task.status]}</span>
            </button>

            {/* Title + time */}
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm text-[var(--text)] truncate', task.status === 'done' && 'line-through opacity-50')}>
                {task.title}
              </p>
              <p className="font-mono text-[10px] text-[var(--muted)] flex items-center gap-1.5">
                <span>{formatTimeAgo(task.createdAt)}</span>
                {task.issueNumber != null && (
                  <>
                    <a
                      href={task.issueUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-[var(--accent)] hover:underline"
                    >
                      #{task.issueNumber}
                    </a>
                    {task.issueState && <span className="text-[var(--muted)]">{task.issueState.toLowerCase()}</span>}
                  </>
                )}
              </p>
            </div>

            {/* Dispatch agent button */}
            <button
              onClick={() => dispatchAgent.mutate(task)}
              disabled={pendingDispatchIds.has(task.id) || dispatchWorkflow.isPending}
              title="Quick single agent run for this task (use the checkboxes + bar below for a delegation workflow: implementer→review→controller)"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 rounded-control border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--accent-hover)] hover:text-[var(--accent-hover)] transition-all disabled:opacity-40"
            >
              ▶ Dispatch agent
            </button>

            {/* Delete task */}
            <button
              data-testid={`task-delete-btn-${task.id}`}
              onClick={() => setDeletingTask(task)}
              aria-label={`Delete task: ${task.title}`}
              title="Delete task"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-control text-[var(--muted)] hover:bg-red/15 hover:text-[var(--red)] transition-all"
            >
              🗑
            </button>
          </div>
        ))}
      </div>

      {/* Action bar — pinned below the scroll area by the flex column (not CSS position:sticky); delegation workflow on the current selection */}
      {selectedIds.size > 0 && (
        <div
          data-testid="tasks-workflow-bar"
          role="region"
          aria-label="Delegation workflow actions"
          className="flex-shrink-0 px-4 py-3 border-t border-[var(--border)] flex items-center justify-between gap-3 bg-[var(--raised)]"
        >
          <div className="flex items-center gap-2">
            <button
              data-testid="tasks-run-workflow"
              onClick={() => dispatchWorkflow.mutate([...selectedIds])}
              disabled={dispatchWorkflow.isPending || selectedIds.size === 0}
              title="Run a delegation workflow (implementer→review→controller) across the selected tasks"
              className="rounded-control bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              {dispatchWorkflow.isPending
                ? 'Dispatching…'
                : `▶ Run delegation workflow on ${selectedIds.size} selected`}
            </button>
            {dispatchWorkflow.isError && (
              <span className="text-[11px] text-[var(--red)]">⚠ {(dispatchWorkflow.error as Error)?.message ?? String(dispatchWorkflow.error)}</span>
            )}
          </div>
          <button
            data-testid="tasks-bar-clear"
            onClick={clearSelection}
            className="text-[11px] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
          >
            clear
          </button>
        </div>
      )}

      {/* Footer: GitHub Issues sync */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-[var(--border)] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncIssues.mutate()}
            disabled={syncIssues.isPending}
            title="Pull this project's GitHub issues into the task list"
            className="text-xs text-[var(--text)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
          >
            {syncIssues.isPending ? 'Syncing…' : 'Sync with GitHub Issues'}
          </button>
          {syncIssues.isSuccess && syncIssues.data?.degraded && (
            <span className="text-[11px] text-[var(--muted)]">gh unavailable — nothing synced</span>
          )}
          {syncIssues.isError && (
            <span className="text-[11px] text-[var(--red)]">⚠ {String(syncIssues.error)}</span>
          )}
        </div>
        {createTask.isError && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(createTask.error)}</span>
        )}
      </div>

      {/* Workflow dispatch feedback: confirm the run fired + jump to its console. */}
      <Toast
        open={dispatched !== null}
        testid="tasks-workflow-toast"
        message={
          <>
            Delegation workflow dispatched on{' '}
            <span className="font-medium text-[var(--text)]">{dispatched?.count} task{dispatched?.count === 1 ? '' : 's'}</span>
          </>
        }
        action={{
          label: 'View run →',
          testid: 'tasks-workflow-toast-link',
          onClick: () => dispatched && navigate('runs', dispatched.runId),
        }}
        onDismiss={() => setDispatched(null)}
      />

      <ConfirmDialog
        open={deletingTask !== null}
        testid="task-delete"
        title="Delete task"
        message={
          <>
            Delete <span className="font-semibold text-[var(--text)]">{deletingTask?.title}</span>? This
            cannot be undone.
          </>
        }
        confirmLabel="Delete task"
        busy={deleteTask.isPending}
        error={deleteTask.isError ? String(deleteTask.error) : undefined}
        onConfirm={() => deletingTask && deleteTask.mutate(deletingTask.id)}
        onCancel={closeDeleteTask}
      />
    </div>
  )
}
