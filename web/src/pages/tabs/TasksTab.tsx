import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProjectTask } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'

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

  const { data: tasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.projects.tasks.list(projectId),
    refetchInterval: 10_000,
  })

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

  const dispatchAgent = useMutation({
    mutationFn: (task: ProjectTask) =>
      api.runs.start(task.title, { projectId }),
    onMutate: (task) => setPendingDispatchIds(s => new Set(s).add(task.id)),
    onSettled: (_d, _e, task) => setPendingDispatchIds(s => { const n = new Set(s); n.delete(task.id); return n }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', 'project', projectId] })
    },
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
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {createTask.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

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
              disabled={pendingDispatchIds.has(task.id)}
              title="Dispatch an agent run for this task"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent-hover)] transition-all disabled:opacity-40"
            >
              ▶ Dispatch agent
            </button>
          </div>
        ))}
      </div>

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
    </div>
  )
}
