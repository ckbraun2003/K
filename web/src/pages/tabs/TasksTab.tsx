import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProjectTask } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { navigate } from '../../lib/route'
import Toast from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Icon } from '../../ui/Icon'
import { Button, IconButton } from '../../ui/Button'
import { Checkbox, Input } from '../../ui/Field'
import { EmptyState } from '../../ui/EmptyState'

interface Props {
  projectId: string
}

const STATUS_CYCLE: Record<ProjectTask['status'], ProjectTask['status']> = {
  open:        'in_progress',
  in_progress: 'done',
  done:        'open',
}

const STATUS_DOT: Record<ProjectTask['status'], string> = {
  open:        'bg-amber',
  in_progress: 'bg-accent',
  done:        'bg-green',
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
  // Synchronous re-entrancy guard so a same-tick double-submit (rapid double-click,
  // or Enter + click) can't fire the create mutation twice before `isPending`
  // re-renders the disabled button (fix F-041).
  const addGuard = useRef(false)
  const [pendingDispatchIds, setPendingDispatchIds] = useState<Set<string>>(new Set())
  // Multi-select for the "run delegation workflow" path (distinct from the per-row quick dispatch).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Success toast pointing at the orchestrator run the workflow dispatch created.
  const [dispatched, setDispatched] = useState<{ runId: string; count: number } | null>(null)
  // Task pending a delete confirm.
  const [deletingTask, setDeletingTask] = useState<ProjectTask | null>(null)
  // Task pending a dispatch confirm — a per-row dispatch spends tokens, so it must
  // be confirmed rather than firing a paid run on a single stray click (fix F-040).
  const [dispatchingTask, setDispatchingTask] = useState<ProjectTask | null>(null)

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
    // Release the double-submit guard once the create settles (success OR error),
    // so a failed add can be retried.
    onSettled: () => { addGuard.current = false },
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
      setDispatchingTask(null)
    },
  })
  function closeDispatch() { setDispatchingTask(null); dispatchAgent.reset() }

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
    if (!t || addGuard.current || createTask.isPending) return
    addGuard.current = true
    createTask.mutate(t)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAdd()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Add task input */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center gap-2">
        <Input
          ref={inputRef}
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="New task title…"
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleAdd}
          disabled={!newTitle.trim() || createTask.isPending}
          loading={createTask.isPending}
        >
          {createTask.isPending ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {/* Selection bar: select-all + clear */}
      {tasks.length > 0 && (
        <div className="flex-shrink-0 px-4 py-1.5 border-b border-border flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
            <Checkbox
              data-testid="tasks-select-all"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = someSelected }}
              onChange={toggleSelectAll}
              className="h-3.5 w-3.5"
            />
            Select all
          </label>
          {selectedIds.size > 0 && (
            <span className="text-[11px] text-muted">
              {selectedIds.size} selected ·{' '}
              <button
                data-testid="tasks-header-clear"
                onClick={clearSelection}
                className="text-accent hover:underline"
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
          <EmptyState
            icon="personal"
            headline="No tasks yet."
            hint="Add one above."
            cta={{ label: 'Add a task', onClick: () => inputRef.current?.focus() }}
          />
        )}
        {tasks.map(task => (
          <div
            key={task.id}
            className="group flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-surface transition-colors"
          >
            {/* Multi-select checkbox (workflow delegation path) */}
            <Checkbox
              data-testid={`task-select-${task.id}`}
              checked={selectedIds.has(task.id)}
              onChange={() => toggleSelect(task.id)}
              aria-label={`Select task: ${task.title}`}
              className="flex-shrink-0 h-3.5 w-3.5"
            />

            {/* Status toggle */}
            <button
              onClick={() => updateStatus.mutate({ taskId: task.id, status: STATUS_CYCLE[task.status] })}
              title={`Status: ${STATUS_LABEL[task.status]} — click to advance`}
              className="flex-shrink-0 flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium border border-border hover:border-accent transition-colors"
            >
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[task.status])} />
              <span className="text-muted">{STATUS_LABEL[task.status]}</span>
            </button>

            {/* Title + time */}
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm text-text truncate', task.status === 'done' && 'line-through opacity-50')}>
                {task.title}
              </p>
              <p className="mono text-[10px] text-muted flex items-center gap-1.5">
                <span>{formatTimeAgo(task.createdAt)}</span>
                {task.issueNumber != null && (
                  <>
                    <a
                      href={task.issueUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-accent hover:underline"
                    >
                      #{task.issueNumber}
                    </a>
                    {task.issueState && <span className="text-muted">{task.issueState.toLowerCase()}</span>}
                  </>
                )}
              </p>
            </div>

            {/* Dispatch agent button — opens a confirm first (a per-row dispatch is a PAID run) */}
            <Button
              data-testid={`task-dispatch-btn-${task.id}`}
              variant="glass"
              size="sm"
              icon="runs"
              onClick={() => setDispatchingTask(task)}
              disabled={pendingDispatchIds.has(task.id) || dispatchWorkflow.isPending}
              title="Quick single agent run for this task (use the checkboxes + bar below for a delegation workflow: implementer→review→orchestrator)"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 transition-all"
            >
              Dispatch agent
            </Button>

            {/* Delete task */}
            <IconButton
              data-testid={`task-delete-btn-${task.id}`}
              name="trash"
              variant="ghost"
              label={`Delete task: ${task.title}`}
              onClick={() => setDeletingTask(task)}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 hover:bg-red/15 hover:text-red transition-all"
            />
          </div>
        ))}
      </div>

      {/* Action bar — pinned below the scroll area by the flex column (not CSS position:sticky); delegation workflow on the current selection */}
      {selectedIds.size > 0 && (
        <div
          data-testid="tasks-workflow-bar"
          role="region"
          aria-label="Delegation workflow actions"
          className="flex-shrink-0 px-4 py-3 border-t border-border flex items-center justify-between gap-3 bg-raised"
        >
          <div className="flex items-center gap-2">
            <Button
              data-testid="tasks-run-workflow"
              variant="primary"
              size="sm"
              icon="runs"
              loading={dispatchWorkflow.isPending}
              onClick={() => dispatchWorkflow.mutate([...selectedIds])}
              disabled={dispatchWorkflow.isPending || selectedIds.size === 0}
              title="Run a delegation workflow (implementer→review→orchestrator) across the selected tasks"
            >
              {dispatchWorkflow.isPending
                ? 'Dispatching…'
                : `Run delegation workflow on ${selectedIds.size} selected`}
            </Button>
            {dispatchWorkflow.isError && (
              <span className="flex items-center gap-1 text-[11px] text-red">
                <Icon name="warning" size={14} />
                {(dispatchWorkflow.error as Error)?.message ?? String(dispatchWorkflow.error)}
              </span>
            )}
          </div>
          <button
            data-testid="tasks-bar-clear"
            onClick={clearSelection}
            className="text-[11px] text-muted hover:text-text transition-colors"
          >
            clear
          </button>
        </div>
      )}

      {/* Footer: GitHub Issues sync */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="glass"
            size="sm"
            icon="refresh"
            loading={syncIssues.isPending}
            disabled={syncIssues.isPending}
            title="Pull this project's GitHub issues into the task list"
            onClick={() => syncIssues.mutate()}
          >
            Sync with GitHub Issues
          </Button>
          {syncIssues.isSuccess && syncIssues.data?.degraded && (
            <span className="text-[11px] text-muted">gh unavailable — nothing synced</span>
          )}
          {syncIssues.isSuccess && !syncIssues.data?.degraded && (
            <span data-testid="tasks-sync-result" className="text-[11px] text-muted">
              {syncIssues.data && syncIssues.data.synced > 0
                ? `Synced ${syncIssues.data.synced} issue${syncIssues.data.synced === 1 ? '' : 's'}`
                : 'No new issues'}
            </span>
          )}
          {syncIssues.isError && (
            <span className="flex items-center gap-1 text-[11px] text-red">
              <Icon name="warning" size={14} />
              {String(syncIssues.error)}
            </span>
          )}
        </div>
        {createTask.isError && (
          <span className="flex items-center gap-1 text-[11px] text-red">
            <Icon name="warning" size={14} />
            {String(createTask.error)}
          </span>
        )}
      </div>

      {/* Workflow dispatch feedback: confirm the run fired + jump to its console. */}
      <Toast
        open={dispatched !== null}
        testid="tasks-workflow-toast"
        message={
          <>
            Delegation workflow dispatched on{' '}
            <span className="font-medium text-text">{dispatched?.count} task{dispatched?.count === 1 ? '' : 's'}</span>
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
        open={dispatchingTask !== null}
        testid="task-dispatch"
        title="Dispatch agent"
        message={
          <>
            Start a paid agent run for{' '}
            <span className="font-semibold text-text">{dispatchingTask?.title}</span>? This
            spends tokens.
          </>
        }
        confirmLabel="Dispatch agent"
        busy={dispatchAgent.isPending}
        error={dispatchAgent.isError ? String(dispatchAgent.error) : undefined}
        onConfirm={() => dispatchingTask && dispatchAgent.mutate(dispatchingTask)}
        onCancel={closeDispatch}
      />

      <ConfirmDialog
        open={deletingTask !== null}
        testid="task-delete"
        title="Delete task"
        message={
          <>
            Delete <span className="font-semibold text-text">{deletingTask?.title}</span>? This
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
