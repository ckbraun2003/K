import { useQuery } from '@tanstack/react-query'
import type { KSchedule } from '@k/shared'
import { api } from '../../../lib/api'

/** Short "Jul 2 · 14:00" stamp for schedule rows — same formatting KHome uses. */
function shortWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * ScheduleWidget (UI Simplification Task 13) — ports KHome's read-only
 * Schedule card (formerly KHome.tsx:322-351) verbatim into a widget cell:
 * upcoming events + reminders, overdue reminders tinted red. Same
 * `['k-schedule']` key KHome reads.
 */
export default function ScheduleWidget() {
  const { data: schedule, isError } = useQuery<KSchedule>({ queryKey: ['k-schedule'], queryFn: () => api.k.schedule() })
  const now = Date.now()
  const events = schedule?.events ?? []
  const reminders = schedule?.reminders ?? []

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Schedule</h2>
      {isError ? (
        <p data-testid="widget-schedule-error" className="text-xs italic text-[var(--red)]">Failed to load schedule.</p>
      ) : events.length === 0 && reminders.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">Nothing scheduled.</p>
      ) : (
        <ul className="space-y-1">
          {events.map(ev => (
            <li key={ev.id} className="flex items-baseline gap-2 text-xs">
              <span className="mono flex-shrink-0 text-[10px] text-[var(--muted)]">{shortWhen(ev.startsAt)}</span>
              <span className="min-w-0 truncate text-[var(--text)]">{ev.title}</span>
            </li>
          ))}
          {reminders.map(r => (
            <li key={r.id} className="flex items-baseline gap-2 text-xs">
              <span className={`mono flex-shrink-0 text-[10px] ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`}>
                {shortWhen(r.remindAt)}
              </span>
              <span className={`min-w-0 truncate ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--text)]'}`}>
                ⏰ {r.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
