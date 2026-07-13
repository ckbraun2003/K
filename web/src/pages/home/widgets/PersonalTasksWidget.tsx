import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkItem } from '@k/shared'
import { api } from '../../../lib/api'
import { SectionHeader } from '../../../ui/SectionHeader'
import { Icon } from '../../../ui/Icon'
import { Skeleton } from '../../../ui/Skeleton'

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
  const { data: items = [], isError, isPending } = useQuery<WorkItem[]>({
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
      <SectionHeader label="Personal tasks" />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 rounded-control" />
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p data-testid="widget-personal-tasks-error" className="text-caption text-red">Failed to load work items.</p>
      ) : items.length === 0 ? (
        // Hand-rolled (not <EmptyState>): this cell renders inside OverviewView's
        // GlassPanel tier="panel" — EmptyState's own icon bubble is itself a
        // glass-panel, which would nest backdrop-filter inside backdrop-filter.
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-4 text-center">
          <Icon name="personal" size={20} className="text-muted" />
          <p className="text-body font-medium text-text">No personal work items yet.</p>
        </div>
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
                className="flex-shrink-0 accent-accent"
              />
              <span className={`min-w-0 flex-1 truncate text-body ${item.status === 'done' ? 'text-muted line-through' : 'text-text'}`}>
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
          className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2 py-1 text-body text-text outline-none placeholder:text-muted focus:border-accent/40"
        />
        <button
          type="button"
          data-testid="widget-personal-tasks-add"
          disabled={!title.trim() || addItem.isPending}
          onClick={() => addItem.mutate(title.trim())}
          className="flex-shrink-0 rounded-control border border-border px-2 py-1 text-body font-semibold text-accent-hover transition-colors hover:border-accent/40 disabled:opacity-50"
        >
          add
        </button>
      </div>
      {(toggleItem.isError || addItem.isError) && (
        <p data-testid="widget-personal-tasks-mutation-error" className="flex items-center gap-1 text-caption text-red">
          <Icon name="warning" size={14} />
          {((toggleItem.error ?? addItem.error) as Error).message}
        </p>
      )}
    </div>
  )
}
