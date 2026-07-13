import { useQuery } from '@tanstack/react-query'
import type { Note } from '@k/shared'
import { api } from '../../../lib/api'
import { SectionHeader } from '../../../ui/SectionHeader'
import { Icon } from '../../../ui/Icon'
import { Skeleton } from '../../../ui/Skeleton'

/**
 * NotesWidget (UI Simplification Task 13) — ports KHome's read-only Notes
 * card (formerly KHome.tsx:298-319) verbatim into a widget cell. Same
 * `['k-notes']` key KHome reads — the terminal `run_update` invalidator
 * (live-invalidate.ts) refreshes it live (K may write a note mid-run).
 */
export default function NotesWidget() {
  const { data: notes = [], isError, isPending } = useQuery<Note[]>({ queryKey: ['k-notes'], queryFn: () => api.k.notes() })

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <SectionHeader label="Notes" />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="space-y-1.5">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-5/6" />
        </div>
      ) : isError ? (
        <p data-testid="widget-notes-error" className="text-caption text-red">Failed to load notes.</p>
      ) : notes.length === 0 ? (
        // Hand-rolled (not <EmptyState>): this cell renders inside OverviewView's
        // GlassPanel tier="panel" — EmptyState's own icon bubble is itself a
        // glass-panel, which would nest backdrop-filter inside backdrop-filter.
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-4 text-center">
          <Icon name="file" size={20} className="text-muted" />
          <p className="text-body font-medium text-text">No notes yet — ask K to take one.</p>
        </div>
      ) : (
        <ul className="space-y-1">
          {notes.map(n => (
            <li key={n.id} className={`truncate text-body ${n.done ? 'text-muted line-through' : 'text-text'}`}>
              {n.done && <span className="mr-1 text-green">✓</span>}
              {n.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
