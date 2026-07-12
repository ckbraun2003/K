/**
 * Home layout — grid math + persistence (UI Simplification Task 12). The Home
 * Overview surface is a fixed 3x3 grid (spec 5.2/8.3); `HomeLayoutSchema`
 * (Task 1, shared/src/types.ts) already enforces in-bounds/non-overlap/no-
 * duplicate server-side — `fits`/`findSlot` here are the CLIENT-side mirror of
 * that same geometry so the customize-mode UI (OverviewView/WidgetShell) can
 * only ever construct a layout the server will accept (never round-trips a
 * 400).
 *
 * `useHomeLayout` owns the `['home-layout']` query key end to end: `save`
 * writes optimistically (`setQueryData`) before the PUT resolves so
 * customize-mode feels instant, then fires the PUT to persist. It cancels any
 * in-flight GET first — the standard react-query optimistic-update guard —
 * so a slow initial fetch that resolves AFTER an edit can't stomp the
 * optimistic write with stale (pre-edit) server data. A failed PUT is
 * swallowed (best-effort, matching useAskK's undo idiom): the optimistic
 * cache entry stands until the next successful GET/PUT reconciles it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { HomeLayout, HomeWidgetPlacement, HomeWidgetId } from '@k/shared'
import { api } from './api'

export const HOME_LAYOUT_KEY = ['home-layout'] as const

export const DEFAULT_LAYOUT: HomeLayout = {
  widgets: [
    { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 },
    { id: 'needs_you', x: 2, y: 0, w: 1, h: 1 },
    { id: 'recent_activity', x: 0, y: 1, w: 2, h: 2 },
    { id: 'cost_today', x: 2, y: 1, w: 1, h: 1 },
    { id: 'personal_tasks', x: 2, y: 2, w: 1, h: 1 },
  ],
}

/** True if `p` is in-bounds on the 3x3 grid and doesn't overlap any OTHER
 *  placement already in `layout` — `ignoreId` excludes the placement being
 *  moved/resized from the overlap check against its OWN prior footprint, so a
 *  widget can be re-placed in place without colliding with itself. Mirrors
 *  `HomeLayoutSchema`'s superRefine bounds/overlap rule exactly. */
export function fits(layout: HomeLayout, p: HomeWidgetPlacement, ignoreId?: HomeWidgetId): boolean {
  if (p.x + p.w > 3 || p.y + p.h > 3) return false
  const taken = new Set<string>()
  for (const w of layout.widgets) {
    if (w.id === ignoreId) continue
    for (let dx = 0; dx < w.w; dx++) for (let dy = 0; dy < w.h; dy++) taken.add(`${w.x + dx},${w.y + dy}`)
  }
  for (let dx = 0; dx < p.w; dx++) for (let dy = 0; dy < p.h; dy++) {
    if (taken.has(`${p.x + dx},${p.y + dy}`)) return false
  }
  return true
}

/** First-fit row-major scan for a free `w`x`h` slot. `id` on the probe
 *  placement is irrelevant to the geometry (fits() only excludes a widget
 *  sharing `ignoreId`, which is never passed here) — 'notes' is just a
 *  placeholder to satisfy the shape. */
export function findSlot(layout: HomeLayout, w: 1 | 2, h: 1 | 2): { x: number; y: number } | null {
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    if (fits(layout, { id: 'notes', x, y, w, h })) return { x, y }
  }
  return null
}

/** The Overview grid's ONE source of truth. `layout` falls back to
 *  DEFAULT_LAYOUT both while the initial GET is in flight and if the operator
 *  never saved one (the server answers `{ layout: null }` in that case,
 *  spec §8.3) — the grid always has something to render, never a blank state.
 *  `loaded` is `true` once the first GET has actually resolved (react-query
 *  `isSuccess`), for callers that want to gate a first-load affordance. */
export function useHomeLayout(): { layout: HomeLayout; save: (next: HomeLayout) => void; loaded: boolean } {
  const qc = useQueryClient()
  const { data, isSuccess } = useQuery({ queryKey: HOME_LAYOUT_KEY, queryFn: () => api.homeLayout.get() })
  const layout = data?.layout ?? DEFAULT_LAYOUT

  function save(next: HomeLayout) {
    // Cancel the in-flight initial GET (if any) BEFORE writing — otherwise its
    // (older) response can land after this optimistic write and silently
    // revert it to pre-edit state.
    void qc.cancelQueries({ queryKey: HOME_LAYOUT_KEY })
    qc.setQueryData(HOME_LAYOUT_KEY, { layout: next })
    void api.homeLayout.put(next).catch(() => { /* best-effort; optimistic cache entry stands */ })
  }

  return { layout, save, loaded: isSuccess }
}
