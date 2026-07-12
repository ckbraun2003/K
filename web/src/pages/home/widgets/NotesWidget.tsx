import { useQuery } from '@tanstack/react-query'
import type { Note } from '@k/shared'
import { api } from '../../../lib/api'

/**
 * NotesWidget (UI Simplification Task 13) — ports KHome's read-only Notes
 * card (formerly KHome.tsx:298-319) verbatim into a widget cell. Same
 * `['k-notes']` key KHome reads — the terminal `run_update` invalidator
 * (live-invalidate.ts) refreshes it live (K may write a note mid-run).
 */
export default function NotesWidget() {
  const { data: notes = [], isError } = useQuery<Note[]>({ queryKey: ['k-notes'], queryFn: () => api.k.notes() })

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Notes</h2>
      {isError ? (
        <p data-testid="widget-notes-error" className="text-xs italic text-[var(--red)]">Failed to load notes.</p>
      ) : notes.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">No notes yet — ask K to take one.</p>
      ) : (
        <ul className="space-y-1">
          {notes.map(n => (
            <li key={n.id} className={`truncate text-xs ${n.done ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}>
              {n.done && <span className="mr-1 text-[var(--green)]">✓</span>}
              {n.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
