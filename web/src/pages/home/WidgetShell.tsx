import type { HomeLayout, HomeWidgetPlacement } from '@k/shared'
import { fits } from '../../lib/home-layout'

const SIZES: Array<[1 | 2, 1 | 2]> = [[1, 1], [2, 1], [1, 2], [2, 2]]

interface Props {
  placement: HomeWidgetPlacement
  layout: HomeLayout
  onChange: (next: HomeLayout) => void
}

/**
 * Per-widget customize chrome (UI Simplification Task 12) — rendered above a
 * widget's body only while Overview is in customize mode (OverviewView).
 * Every mutation goes through `onChange` with a FULL next `HomeLayout` (never
 * a partial patch), so the caller's `save` (lib/home-layout.ts `useHomeLayout`)
 * stays the single write path. Size/move options are pre-filtered through
 * `fits` (ignoring this widget's OWN current footprint via `ignoreId`), so a
 * click can never construct a layout the server's `HomeLayoutSchema` would
 * reject.
 */
export default function WidgetShell({ placement, layout, onChange }: Props) {
  function replace(next: HomeWidgetPlacement) {
    onChange({ widgets: layout.widgets.map(w => (w.id === placement.id ? next : w)) })
  }

  function remove() {
    onChange({ widgets: layout.widgets.filter(w => w.id !== placement.id) })
  }

  const moveCells: { x: number; y: number }[] = []
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    if (fits(layout, { ...placement, x, y }, placement.id)) moveCells.push({ x, y })
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)]/70 p-1 text-[10px]">
      <span className="mr-auto truncate font-medium text-[var(--text)]">{placement.id}</span>
      {SIZES.map(([w, h]) => {
        const active = placement.w === w && placement.h === h
        const ok = active || fits(layout, { ...placement, w, h }, placement.id)
        return (
          <button
            key={`${w}x${h}`}
            type="button"
            data-testid={`widget-resize-${placement.id}-${w}x${h}`}
            aria-pressed={active}
            disabled={!ok}
            onClick={() => replace({ ...placement, w, h })}
            className={`rounded px-1 py-0.5 transition-colors ${
              active ? 'bg-[var(--accent)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
            } disabled:opacity-30`}
          >
            {w}x{h}
          </button>
        )
      })}
      <select
        aria-label={`Move ${placement.id}`}
        data-testid={`widget-move-${placement.id}`}
        value={`${placement.x},${placement.y}`}
        onChange={(e) => {
          const [x, y] = e.target.value.split(',').map(Number)
          replace({ ...placement, x, y })
        }}
        className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[var(--muted)]"
      >
        {moveCells.map(({ x, y }) => (
          <option key={`${x}-${y}`} value={`${x},${y}`}>{x},{y}</option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`widget-remove-${placement.id}`}
        aria-label={`Remove ${placement.id}`}
        onClick={remove}
        className="px-1 text-[var(--red)] transition-opacity hover:opacity-80"
      >
        &times;
      </button>
    </div>
  )
}
