/**
 * home-layout.ts pure-lib tests (UI Simplification Task 12) — DEFAULT_LAYOUT
 * schema validity + cell coverage, and the grid math (`findSlot`/`fits`) the
 * customize-mode UI (OverviewView/WidgetShell) builds on. Pure functions only
 * — no network/DOM here; `useHomeLayout` is exercised via overview-view.test.tsx.
 */
import { describe, it, expect } from 'vitest'
import { HomeLayoutSchema, type HomeLayout } from '@k/shared'
import { DEFAULT_LAYOUT, findSlot, fits } from '../src/lib/home-layout'

describe('DEFAULT_LAYOUT', () => {
  it('validates against HomeLayoutSchema and fills exactly 9 cells', () => {
    expect(HomeLayoutSchema.safeParse(DEFAULT_LAYOUT).success).toBe(true)
    const cells = DEFAULT_LAYOUT.widgets.reduce((n, w) => n + w.w * w.h, 0)
    expect(cells).toBe(9)
  })
})

describe('findSlot', () => {
  it('returns the first row-major fit and null when full', () => {
    expect(findSlot({ widgets: [] }, 2, 2)).toEqual({ x: 0, y: 0 })
    expect(findSlot(DEFAULT_LAYOUT, 1, 1)).toBeNull()
  })

  it('scans row-major, skipping cells already taken', () => {
    const layout: HomeLayout = { widgets: [{ id: 'active_runs', x: 0, y: 0, w: 2, h: 1 }] }
    // (0,0) and (1,0) are taken -> the first free 1x1 cell is (2,0), not (0,1).
    expect(findSlot(layout, 1, 1)).toEqual({ x: 2, y: 0 })
  })

  it('returns null when a 2x2 slot cannot fit anywhere, even with free cells left', () => {
    // Every row has exactly one free column after this arrangement -> no 2-wide span fits.
    const layout: HomeLayout = {
      widgets: [
        { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 },
        { id: 'needs_you', x: 2, y: 0, w: 1, h: 1 },
        { id: 'recent_activity', x: 0, y: 1, w: 2, h: 1 },
        { id: 'cost_today', x: 2, y: 1, w: 1, h: 1 },
      ],
    }
    expect(findSlot(layout, 2, 2)).toBeNull()
  })
})

describe('fits', () => {
  it('accepts any 1x1/2x2 placement against an empty layout at the origin', () => {
    expect(fits({ widgets: [] }, { id: 'notes', x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(fits({ widgets: [] }, { id: 'notes', x: 0, y: 0, w: 2, h: 2 })).toBe(true)
  })

  it('rejects out-of-bounds placements at the right and bottom edges', () => {
    expect(fits({ widgets: [] }, { id: 'notes', x: 2, y: 0, w: 2, h: 1 })).toBe(false) // x+w=4>3
    expect(fits({ widgets: [] }, { id: 'notes', x: 0, y: 2, w: 1, h: 2 })).toBe(false) // y+h=4>3
    expect(fits({ widgets: [] }, { id: 'notes', x: 2, y: 2, w: 1, h: 1 })).toBe(true) // exact fit, in bounds
  })

  it('rejects overlap with an existing widget', () => {
    expect(fits(DEFAULT_LAYOUT, { id: 'notes', x: 0, y: 0, w: 1, h: 1 })).toBe(false)
    expect(fits(DEFAULT_LAYOUT, { id: 'notes', x: 1, y: 1, w: 1, h: 1 })).toBe(false)
  })

  it('honors ignoreId for self-resize but still rejects collisions with OTHER widgets', () => {
    // active_runs occupies (0,0)-(1,0); re-placing it at its own footprint must fit
    // against itself once ignored.
    expect(fits(DEFAULT_LAYOUT, { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 }, 'active_runs')).toBe(true)
    // Growing active_runs to 2x2 collides with recent_activity (a DIFFERENT widget) at
    // (0,1)/(1,1) -> ignoreId does not rescue a collision with someone else's cells.
    expect(fits(DEFAULT_LAYOUT, { id: 'active_runs', x: 0, y: 0, w: 2, h: 2 }, 'active_runs')).toBe(false)
    // Without ignoreId, even the widget's OWN unchanged footprint reads as a collision.
    expect(fits(DEFAULT_LAYOUT, { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 })).toBe(false)
  })

  it('a full grid (DEFAULT_LAYOUT) has no free cell for any size', () => {
    expect(findSlot(DEFAULT_LAYOUT, 1, 1)).toBeNull()
    expect(fits(DEFAULT_LAYOUT, { id: 'notes', x: 1, y: 1, w: 1, h: 1 })).toBe(false)
  })

  it('computes free cells correctly even when the input layout is itself overlapping (a corrupt/legacy stored value)', () => {
    const corrupt: HomeLayout = {
      widgets: [
        { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 },
        { id: 'needs_you', x: 1, y: 0, w: 1, h: 1 }, // overlaps active_runs at (1,0)
      ],
    }
    // (1,0) is double-claimed but still correctly excluded from free cells.
    expect(fits(corrupt, { id: 'notes', x: 1, y: 0, w: 1, h: 1 })).toBe(false)
    // (2,0) remains free and is found first (row-major).
    expect(findSlot(corrupt, 1, 1)).toEqual({ x: 2, y: 0 })
  })
})
