import type { HomeLayout, HomeWidgetPlacement } from '@k/shared'
import SegControl from '../../components/SegControl'
import { fits } from '../../lib/home-layout'
import { WIDGET_DEFS } from './widgets'
import { IconButton } from '../../ui/Button'

type SizeKey = '1x1' | '2x1' | '1x2' | '2x2'
const SIZES: Array<{ key: SizeKey; w: 1 | 2; h: 1 | 2 }> = [
  { key: '1x1', w: 1, h: 1 },
  { key: '2x1', w: 2, h: 1 },
  { key: '1x2', w: 1, h: 2 },
  { key: '2x2', w: 2, h: 2 },
]

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
 * reject. Sizing uses the canonical SegControl (per-option `disabled` for
 * non-fitting sizes, accent activeTone) — testids are SegControl's own
 * `seg-<size>`.
 */
export default function WidgetShell({ placement, layout, onChange }: Props) {
  const title = WIDGET_DEFS[placement.id].title
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
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-bg/70 p-1 text-micro">
      <span className="mr-auto truncate font-medium text-text">{title}</span>
      <SegControl<SizeKey>
        size="sm"
        activeTone="accent"
        ariaLabel={`Resize ${title}`}
        options={SIZES.map(({ key, w, h }) => {
          const active = placement.w === w && placement.h === h
          return { label: key, value: key, disabled: !active && !fits(layout, { ...placement, w, h }, placement.id) }
        })}
        value={`${placement.w}x${placement.h}` as SizeKey}
        onChange={(v) => {
          const s = SIZES.find(s => s.key === v)!
          replace({ ...placement, w: s.w, h: s.h })
        }}
      />
      <select
        aria-label={`Move ${title}`}
        data-testid={`widget-move-${placement.id}`}
        value={`${placement.x},${placement.y}`}
        onChange={(e) => {
          const [x, y] = e.target.value.split(',').map(Number)
          replace({ ...placement, x, y })
        }}
        className="rounded-control border border-border bg-transparent px-1 py-0.5 text-muted"
      >
        {moveCells.map(({ x, y }) => (
          <option key={`${x}-${y}`} value={`${x},${y}`}>{x},{y}</option>
        ))}
      </select>
      <IconButton
        name="close"
        label={`Remove ${title}`}
        variant="ghost"
        size="sm"
        data-testid={`widget-remove-${placement.id}`}
        onClick={remove}
        className="text-red hover:bg-red/10 hover:text-red"
      />
    </div>
  )
}
