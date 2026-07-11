import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Note, KSchedule, WorkItem } from '@k/shared'
import { api } from '../../lib/api'
import SegControl from '../../components/SegControl'

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

  const { data: items = [], isError: itemsError } = useQuery<WorkItem[]>({
    queryKey: ['k-work-items', 'all'],
    queryFn: () => api.k.workItems.list(),
  })
  const { data: notes = [], isError: notesError } = useQuery<Note[]>({ queryKey: ['k-notes'], queryFn: () => api.k.notes() })
  const { data: schedule, isError: scheduleError } = useQuery<KSchedule>({ queryKey: ['k-schedule'], queryFn: () => api.k.schedule() })

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
      <section data-testid="tasks-workitems" className="glass-tint rounded-panel p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Your work</h2>
          <SegControl<Scope>
            ariaLabel="Work item scope"
            options={[{ label: 'Personal', value: 'personal' }, { label: 'Org', value: 'org' }]}
            value={scope}
            onChange={setScope}
            size="sm"
          />
        </div>
        {itemsError ? (
          <p data-testid="tasks-workitems-error" className="mt-3 text-xs italic text-[var(--red)]">
            Failed to load work items.
          </p>
        ) : filtered.length === 0 ? (
          <p className="mt-3 text-sm italic text-[var(--muted)]">No {scope} work items yet.</p>
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
                  className="flex-shrink-0 accent-[var(--accent)]"
                />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${item.status === 'done' ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}
                >
                  {item.title}
                </span>
                {/* A pill only for the in-between states — open/done read from the checkbox. */}
                {item.status !== 'open' && item.status !== 'done' && (
                  <span className="flex-shrink-0 rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--amber)]">
                    {item.status}
                  </span>
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
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
            />
            <button
              data-testid="tasks-workitem-add"
              type="button"
              disabled={!newItemTitle.trim() || addItem.isPending}
              onClick={() => addItem.mutate(newItemTitle.trim())}
              className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50"
            >
              add
            </button>
          </div>
        ) : (
          <p data-testid="tasks-workitem-add-org-hint" className="mt-3 text-[11px] italic text-[var(--muted)]">
            Org items are created by the org — switch to Personal to add one.
          </p>
        )}
        {/* Mutation failures surface inline — never a silently-lost toggle/add. */}
        {(toggleItem.isError || addItem.isError) && (
          <p data-testid="tasks-workitem-error" className="mt-2 text-[11px] text-[var(--red)]">
            ⚠ {((toggleItem.error ?? addItem.error) as Error).message}
          </p>
        )}
      </section>

      {/* Right: Notes + Schedule, stacked. */}
      <div className="flex flex-col gap-4">
        <section data-testid="tasks-notes" className="glass-tint rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Notes</h2>
          {notesError ? (
            <p data-testid="tasks-notes-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load notes.
            </p>
          ) : notes.length === 0 ? (
            <p className="mt-3 text-sm italic text-[var(--muted)]">No notes yet — ask K to take one.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {notes.map(n => (
                <li
                  key={n.id}
                  className={`truncate text-sm ${n.done ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}
                >
                  {n.done && <span className="mr-1 text-[var(--green)]">✓</span>}
                  {n.body}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="tasks-schedule" className="glass-tint rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Schedule</h2>
          {scheduleError ? (
            <p data-testid="tasks-schedule-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load schedule.
            </p>
          ) : (schedule?.events.length ?? 0) === 0 && (schedule?.reminders.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm italic text-[var(--muted)]">Nothing scheduled.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {(schedule?.events ?? []).map(ev => (
                <li key={ev.id} className="flex items-baseline gap-2 text-sm">
                  <span className="mono flex-shrink-0 text-[11px] text-[var(--muted)]">{shortWhen(ev.startsAt)}</span>
                  <span className="min-w-0 truncate text-[var(--text)]">{ev.title}</span>
                </li>
              ))}
              {(schedule?.reminders ?? []).map(r => (
                <li key={r.id} className="flex items-baseline gap-2 text-sm">
                  {/* Overdue tinted red — the most important thing on the card. */}
                  <span className={`mono flex-shrink-0 text-[11px] ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`}>
                    {shortWhen(r.remindAt)}
                  </span>
                  <span className={`min-w-0 truncate ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--text)]'}`}>
                    ⏰ {r.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
