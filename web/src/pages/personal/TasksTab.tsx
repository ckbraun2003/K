import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Note, KSchedule, WorkItem } from '@k/shared'
import { api } from '../../lib/api'
import { prefillDock } from '../../lib/dock-bus'
import SegControl from '../../components/SegControl'
import { Button } from '../../ui/Button'
import { GlassPanel } from '../../ui/GlassPanel'
import { SectionHeader } from '../../ui/SectionHeader'
import { EmptyState } from '../../ui/EmptyState'
import { SkeletonRow } from '../../ui/Skeleton'
import { StatusPill } from '../../ui/StatusPill'
import { Icon } from '../../ui/Icon'

type Scope = 'personal' | 'org'

/** Short "Jul 2 · 14:00" stamp for schedule rows — same formatting KHome/ScheduleWidget use. */
function shortWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * TasksTab (Personal hub, UI Simplification Task 14) — the full work-item
 * management surface. Left: BOTH-scope durable work items (`api.k.workItems.list()`
 * unscoped) filtered client-side by a Personal/Org SegControl (default personal),
 * ported from KHome's "Your work" card (formerly KHome.tsx:354-423; testids
 * renamed khome-workitem-* -> tasks-workitem-*). Right: the read-only Notes +
 * Schedule cards ported verbatim from KHome (KHome.tsx:296-351; testids
 * khome-notes/khome-schedule -> tasks-notes/tasks-schedule).
 *
 * Query key: ['k-work-items', 'all'] — a SEPARATE cache entry from KHome's/
 * PersonalTasksWidget's personal-only ['k-work-items'] key (the unscoped fetch
 * returns a different data shape: personal + org). Every mutation here still
 * invalidates the bare ['k-work-items'] key; react-query's default invalidation
 * matches BY PREFIX, so that one call also refreshes this tab's ['k-work-items',
 * 'all'] entry and vice versa — the two surfaces stay in sync without sharing a
 * literal query key (which would otherwise let a personal-only read stomp the
 * both-scope one, or vice versa).
 */
export default function TasksTab() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>('personal')
  const [newItemTitle, setNewItemTitle] = useState('')

  const { data: items = [], isError: itemsError, isPending: itemsPending } = useQuery<WorkItem[]>({
    queryKey: ['k-work-items', 'all'],
    queryFn: () => api.k.workItems.list(),
  })
  const { data: notes = [], isError: notesError, isPending: notesPending } = useQuery<Note[]>({ queryKey: ['k-notes'], queryFn: () => api.k.notes() })
  const { data: schedule, isError: scheduleError, isPending: schedulePending } = useQuery<KSchedule>({ queryKey: ['k-schedule'], queryFn: () => api.k.schedule() })

  const toggleItem = useMutation({
    mutationFn: (item: WorkItem) => api.k.workItems.setStatus(item.id, item.status === 'done' ? 'open' : 'done'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k-work-items'] }),
    // Not swallowed — the error renders inline under the list below.
  })
  const addItem = useMutation({
    mutationFn: (title: string) => api.k.workItems.create(title),
    onSuccess: () => {
      // Clear the composer ONLY on success — a failed add keeps the typed title.
      setNewItemTitle('')
      void qc.invalidateQueries({ queryKey: ['k-work-items'] })
    },
  })

  function onAddItemKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const title = newItemTitle.trim()
      if (title && !addItem.isPending) addItem.mutate(title)
    }
  }

  const filtered = items.filter(i => i.scope === scope)
  const now = Date.now()

  return (
    <div className="grid flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
      {/* Left: work items — both scopes fetched, filtered client-side. */}
      <GlassPanel as="section" tier="panel" data-testid="tasks-workitems" className="rounded-panel p-4">
        <SectionHeader
          label="Your work"
          as="h2"
          action={
            <SegControl<Scope>
              ariaLabel="Work item scope"
              options={[{ label: 'Personal', value: 'personal' }, { label: 'Org', value: 'org' }]}
              value={scope}
              onChange={setScope}
              size="sm"
            />
          }
        />
        {itemsPending ? (
          <div className="mt-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : itemsError ? (
          <p data-testid="tasks-workitems-error" className="mt-3 flex items-center gap-1.5 text-caption text-red">
            <Icon name="warning" size={14} className="text-red" />
            Failed to load work items.
          </p>
        ) : filtered.length === 0 ? (
          <EmptyState
            tier="solid"
            icon="personal"
            headline={`No ${scope} work items yet`}
            hint="K files follow-ups here; you can add your own."
            cta={{ label: 'Ask K to plan one', onClick: () => prefillDock('Plan a task: ') }}
            className="mt-3"
          />
        ) : (
          <div className="mt-3 space-y-1.5">
            {filtered.map(item => (
              <div key={item.id} data-testid={`tasks-workitem-${item.id}`} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`tasks-workitem-toggle-${item.id}`}
                  aria-label={`Mark "${item.title}" ${item.status === 'done' ? 'open' : 'done'}`}
                  checked={item.status === 'done'}
                  disabled={toggleItem.isPending}
                  onChange={() => toggleItem.mutate(item)}
                  className="flex-shrink-0 accent-accent"
                />
                <span
                  className={`min-w-0 flex-1 truncate text-body ${item.status === 'done' ? 'text-muted line-through' : 'text-text'}`}
                >
                  {item.title}
                </span>
                {/* A pill only for the in-between states — open/done read from the checkbox.
                    Work-item statuses like 'blocked' aren't in StatusPill's canonical set:
                    the neutral idle-look fallback with the honest literal label is intentional. */}
                {item.status !== 'open' && item.status !== 'done' && (
                  <StatusPill status={item.status} label={item.status} className="flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
        {/* Inline add composer — Enter (IME-guarded) or the add button. create()
            always POSTs scope:'personal' (api.k.workItems.create's contract), so the
            composer only renders under the Personal filter: under Org an add would
            succeed but file into the (hidden) personal list — a silent misfile. Org
            items are operator-global and are created through the kstore MCP tool,
            so Org shows an honest hint instead (review fix, Task 14). */}
        {scope === 'personal' ? (
          <div className="mt-3 flex items-center gap-2">
            <input
              data-testid="tasks-workitem-add-input"
              value={newItemTitle}
              onChange={e => setNewItemTitle(e.target.value)}
              onKeyDown={onAddItemKeyDown}
              placeholder="add a work item…"
              aria-label="New work item title"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-caption text-text placeholder-muted outline-none focus:border-accent-hover/35"
            />
            <Button
              variant="ghost"
              size="sm"
              data-testid="tasks-workitem-add"
              className="flex-shrink-0"
              disabled={!newItemTitle.trim() || addItem.isPending}
              onClick={() => addItem.mutate(newItemTitle.trim())}
            >
              Add
            </Button>
          </div>
        ) : (
          <p data-testid="tasks-workitem-add-org-hint" className="mt-3 text-caption text-muted">
            Org items are created by the org — switch to Personal to add one.
          </p>
        )}
        {/* Mutation failures surface inline — never a silently-lost toggle/add. */}
        {(toggleItem.isError || addItem.isError) && (
          <p data-testid="tasks-workitem-error" className="mt-2 flex items-center gap-1.5 text-caption text-red">
            <Icon name="warning" size={14} className="text-red" />
            {((toggleItem.error ?? addItem.error) as Error).message}
          </p>
        )}
      </GlassPanel>

      {/* Right: Notes + Schedule, stacked. */}
      <div className="flex flex-col gap-4">
        <GlassPanel as="section" tier="panel" data-testid="tasks-notes" className="rounded-panel p-4">
          <SectionHeader label="Notes" as="h2" />
          {notesPending ? (
            <div className="mt-3">
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : notesError ? (
            <p data-testid="tasks-notes-error" className="mt-3 flex items-center gap-1.5 text-caption text-red">
              <Icon name="warning" size={14} className="text-red" />
              Failed to load notes.
            </p>
          ) : notes.length === 0 ? (
            <EmptyState
              tier="solid"
              icon="edit"
              headline="No notes yet"
              cta={{ label: 'Ask K to take a note', onClick: () => prefillDock('Note: ') }}
              className="mt-3"
            />
          ) : (
            <ul className="mt-3 space-y-1.5">
              {notes.map(n => (
                <li
                  key={n.id}
                  className={`truncate text-body ${n.done ? 'text-muted line-through' : 'text-text'}`}
                >
                  {n.done && <span className="mr-1 text-green">✓</span>}
                  {n.body}
                </li>
              ))}
            </ul>
          )}
        </GlassPanel>

        <GlassPanel as="section" tier="panel" data-testid="tasks-schedule" className="rounded-panel p-4">
          <SectionHeader label="Schedule" as="h2" />
          {schedulePending ? (
            <div className="mt-3">
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : scheduleError ? (
            <p data-testid="tasks-schedule-error" className="mt-3 flex items-center gap-1.5 text-caption text-red">
              <Icon name="warning" size={14} className="text-red" />
              Failed to load schedule.
            </p>
          ) : (schedule?.events.length ?? 0) === 0 && (schedule?.reminders.length ?? 0) === 0 ? (
            <p className="mt-3 text-body text-muted">Nothing scheduled.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {(schedule?.events ?? []).map(ev => (
                <li key={ev.id} className="flex items-baseline gap-2 text-body">
                  <span className="mono flex-shrink-0 text-caption text-muted">{shortWhen(ev.startsAt)}</span>
                  <span className="min-w-0 truncate text-text">{ev.title}</span>
                </li>
              ))}
              {(schedule?.reminders ?? []).map(r => (
                <li key={r.id} className="flex items-baseline gap-2 text-body">
                  {/* Overdue tinted red — the most important thing on the card. */}
                  <span className={`mono flex-shrink-0 text-caption ${r.remindAt < now ? 'text-red' : 'text-muted'}`}>
                    {shortWhen(r.remindAt)}
                  </span>
                  <span className={`min-w-0 truncate ${r.remindAt < now ? 'text-red' : 'text-text'}`}>
                    ⏰ {r.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </GlassPanel>
      </div>
    </div>
  )
}
