import type { HomeWidgetId } from '@k/shared'

/**
 * Widget catalog registry (UI Simplification Task 12 — minimal title-card
 * stubs; Task 13 fleshes out the real bodies). Keyed by every `HomeWidgetId`
 * the shared schema enumerates (`HomeWidgetIdSchema`, shared/src/types.ts) —
 * not just DEFAULT_LAYOUT's five — so OverviewView's not-yet-placed picker
 * and WidgetShell's size/move chrome can address the FULL catalog.
 *
 * File is `.tsx` (not the brief's literal `.ts`) because the stub bodies are
 * JSX — no other `.ts` file in this codebase contains JSX; `.tsx` is the
 * established convention wherever a file returns markup. See task report for
 * this and other minimal idiom-matching deviations.
 */
export interface WidgetDef {
  title: string
  component: React.ComponentType
}

function stub(title: string): WidgetDef {
  return { title, component: () => <div className="p-3 text-sm text-[var(--muted)]">{title}</div> }
}

// A literal (not a keyed map()) so TS verifies at compile time that every
// HomeWidgetId has an entry — a future 10th id added to HomeWidgetIdSchema
// (shared/src/types.ts) fails typecheck here instead of rendering a blank cell.
export const WIDGET_DEFS: Record<HomeWidgetId, WidgetDef> = {
  active_runs: stub('Active runs'),
  needs_you: stub('Needs you'),
  org_glance: stub('Org at a glance'),
  recent_activity: stub('Recent activity'),
  cost_today: stub('Cost today'),
  personal_tasks: stub('Personal tasks'),
  notes: stub('Notes'),
  schedule: stub('Schedule'),
  project_health: stub('Project health'),
}
