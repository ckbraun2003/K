import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkItem } from '@k/shared'
import { api } from '../../../lib/api'

/**
 * PersonalTasksWidget (UI Simplification Task 13) — ports KHome's "Your
 * work" card (formerly KHome.tsx:354-423) into a widget cell: list/toggle/
 * add against the durable PERSONAL work-item store (kstore scope='personal').
 * Same `['k-work-items']` key + mutations KHome used — terminal `run_update`
 * invalidates it live (a completed K/agent run may have written an item).
 */
export default function PersonalTasksWidget() {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const { data: items = [], isError } = useQuery<WorkItem[]>({
    queryKey: ['k-work-items'],
    queryFn: () => api.k.workItems.list('personal'),
  })

  const toggleItem = useMutation({
    mutationFn: (item: WorkItem) => api.k.workItems.setStatus(item.id, item.status === 'done' ? 'open' : 'done'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k-work-items'] }),
  })
  const addItem = useMutation({
    mutationFn: (t: string) => api.k.workItems.create(t),
    onSuccess: () => {
      setTitle('')
      void qc.invalidateQueries({ queryKey: ['k-work-items'] })
    },
  })

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const t = title.trim()
      if (t && !addItem.isPending) addItem.mutate(t)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Personal tasks</h2>
      {isError ? (
        <p data-testid="widget-personal-tasks-error" className="text-xs italic text-[var(--red)]">Failed to load work items.</p>
      ) : items.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">No personal work items yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map(item => (
            <div key={item.id} data-testid={`widget-personal-tasks-item-${item.id}`} className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid={`widget-personal-tasks-toggle-${item.id}`}
                aria-label={`Mark "${item.title}" ${item.status === 'done' ? 'open' : 'done'}`}
                checked={item.status === 'done'}
                disabled={toggleItem.isPending}
                onChange={() => toggleItem.mutate(item)}
                className="flex-shrink-0 accent-[var(--accent)]"
              />
              <span className={`min-w-0 flex-1 truncate text-xs ${item.status === 'done' ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}>
                {item.title}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center gap-1.5">
        <input
          data-testid="widget-personal-tasks-add-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="add a task…"
          aria-label="New work item title"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
        />
        <button
          type="button"
          data-testid="widget-personal-tasks-add"
          disabled={!title.trim() || addItem.isPending}
          onClick={() => addItem.mutate(title.trim())}
          className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50"
        >
          add
        </button>
      </div>
      {(toggleItem.isError || addItem.isError) && (
        <p data-testid="widget-personal-tasks-mutation-error" className="text-[11px] text-[var(--red)]">
          ⚠ {((toggleItem.error ?? addItem.error) as Error).message}
        </p>
      )}
    </div>
  )
}
