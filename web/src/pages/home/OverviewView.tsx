import { useState } from 'react'
import type { HomeWidgetId } from '@k/shared'
import { useHomeLayout, fits } from '../../lib/home-layout'
import { WIDGET_DEFS } from './widgets'
import WidgetErrorBoundary from './WidgetErrorBoundary'
import WidgetShell from './WidgetShell'

/**
 * OverviewView — Home's Overview tab (UI Simplification Task 12), replacing
 * the Task-10/11 stub. Renders the operator's saved 3x3 widget grid
 * (`useHomeLayout`, lib/home-layout.ts), falling back to DEFAULT_LAYOUT
 * before the first save. Every cell — including its optional customize
 * chrome (WidgetShell) — is wrapped in its OWN `WidgetErrorBoundary` so one
 * throwing widget body can never take the rest of the grid down.
 *
 * Customize mode (toggle, testid `overview-customize`) reveals: per-widget
 * chrome (resize/move/remove, WidgetShell) on placed cells, and a `+` add
 * button (testid `overview-add-<x>-<y>`) on every free 1x1 cell — computed
 * via `fits`, the same geometry the server-side schema enforces — opening a
 * picker of not-yet-placed catalog widgets (Task 13 fleshes out real bodies;
 * this task's registry is 9 title-card stubs, widgets/index.tsx). A picked
 * widget always lands at 1x1 on the cell that was clicked.
 */
export default function OverviewView() {
  const { layout, save, loaded } = useHomeLayout()
  const [customize, setCustomize] = useState(false)
  const [pickerCell, setPickerCell] = useState<{ x: number; y: number } | null>(null)

  const placedIds = new Set(layout.widgets.map(w => w.id))
  const catalog = Object.keys(WIDGET_DEFS) as HomeWidgetId[]
  const unplaced = catalog.filter(id => !placedIds.has(id))

  const emptyCells: { x: number; y: number }[] = []
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    if (fits(layout, { id: 'notes', x, y, w: 1, h: 1 })) emptyCells.push({ x, y })
  }

  function toggleCustomize() {
    setCustomize(c => !c)
    setPickerCell(null)
  }

  function addWidget(id: HomeWidgetId, x: number, y: number) {
    save({ widgets: [...layout.widgets, { id, x, y, w: 1, h: 1 }] })
    setPickerCell(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {!loaded && <span className="text-[10px] text-[var(--muted)]">Loading layout...</span>}
        <button
          type="button"
          data-testid="overview-customize"
          aria-pressed={customize}
          onClick={toggleCustomize}
          className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
        >
          {customize ? 'Done' : 'Customize'}
        </button>
      </div>
      <div className="grid flex-1 min-h-0 grid-cols-3 grid-rows-3 gap-3">
        {layout.widgets.map((w) => {
          const Def = WIDGET_DEFS[w.id]
          return (
            <div
              key={w.id}
              style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
              className="glass-tint rounded-panel min-h-0 overflow-hidden"
            >
              <WidgetErrorBoundary id={w.id}>
                {customize ? <WidgetShell placement={w} layout={layout} onChange={save} /> : null}
                <Def.component />
              </WidgetErrorBoundary>
            </div>
          )
        })}
        {customize && emptyCells.map(({ x, y }) => (
          <div
            key={`empty-${x}-${y}`}
            style={{ gridColumn: `${x + 1} / span 1`, gridRow: `${y + 1} / span 1` }}
            className="flex flex-col items-center justify-center gap-1 rounded-panel border border-dashed border-[var(--border)] p-2"
          >
            <button
              type="button"
              data-testid={`overview-add-${x}-${y}`}
              aria-label="Add widget"
              onClick={() => setPickerCell(prev => (prev && prev.x === x && prev.y === y ? null : { x, y }))}
              className="text-lg leading-none text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              +
            </button>
            {pickerCell?.x === x && pickerCell?.y === y && (
              <div className="flex max-h-full flex-col gap-0.5 overflow-y-auto">
                {unplaced.map(id => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`overview-add-pick-${id}`}
                    onClick={() => addWidget(id, x, y)}
                    className="rounded px-2 py-0.5 text-left text-[10px] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
                  >
                    {WIDGET_DEFS[id].title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
