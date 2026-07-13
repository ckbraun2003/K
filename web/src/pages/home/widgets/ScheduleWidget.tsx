import { useQuery } from '@tanstack/react-query'
import type { KSchedule } from '@k/shared'
import { api } from '../../../lib/api'
import { SectionHeader } from '../../../ui/SectionHeader'
import { EmptyState } from '../../../ui/EmptyState'
import { Skeleton } from '../../../ui/Skeleton'

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
  const { data: schedule, isError, isPending } = useQuery<KSchedule>({ queryKey: ['k-schedule'], queryFn: () => api.k.schedule() })
  const now = Date.now()
  const events = schedule?.events ?? []
  const reminders = schedule?.reminders ?? []

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <SectionHeader label="Schedule" as="h2" />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p data-testid="widget-schedule-error" className="text-caption text-red">Failed to load schedule.</p>
      ) : events.length === 0 && reminders.length === 0 ? (
        // FU-2: tier="solid" avoids nesting glass-panel (EmptyState's default
        // icon bubble) inside this cell's GlassPanel tier="panel" ancestor
        // (OverviewView) — backdrop-filter can't stack on itself.
        <EmptyState tier="solid" icon="timeline" headline="Nothing scheduled." className="flex-1 gap-1.5 py-4" />
      ) : (
        <ul className="space-y-1">
          {events.map(ev => (
            <li key={ev.id} className="flex items-baseline gap-2 text-body">
              <span className="mono flex-shrink-0 text-micro text-muted">{shortWhen(ev.startsAt)}</span>
              <span className="min-w-0 truncate text-text">{ev.title}</span>
            </li>
          ))}
          {reminders.map(r => (
            <li key={r.id} className="flex items-baseline gap-2 text-body">
              {/* Reminder tint classes are test-locked to the literal 'text-[var(--red)]'
                  string (widgets.test.tsx: "tints overdue reminders red") — left as
                  bracket-notation CSS-var classes verbatim rather than the `text-red`
                  token utility. Not a raw-palette/hex violation (ui-token-gate.test.ts
                  only forbids bare hex and default Tailwind palette classes). */}
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
