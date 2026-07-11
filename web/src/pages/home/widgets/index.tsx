import type { HomeWidgetId } from '@k/shared'
import ActiveRunsWidget from './ActiveRunsWidget'
import NeedsYouWidget from './NeedsYouWidget'
import OrgGlanceWidget from './OrgGlanceWidget'
import RecentActivityWidget from './RecentActivityWidget'
import CostTodayWidget from './CostTodayWidget'
import PersonalTasksWidget from './PersonalTasksWidget'
import NotesWidget from './NotesWidget'
import ScheduleWidget from './ScheduleWidget'
import ProjectHealthWidget from './ProjectHealthWidget'

/**
 * Widget catalog registry (UI Simplification Task 12 built the stub
 * framework; Task 13 wires in the 9 real bodies below — each ports an
 * existing KHome/ActivityStrip/InboxPage section onto a shared query key
 * rather than inventing a new data path; see each widget file's header
 * comment for its source and task-13-report.md for the full mapping).
 *
 * File is `.tsx` (not the brief's literal `.ts`) because widget bodies are
 * JSX — no other `.ts` file in this codebase contains JSX; `.tsx` is the
 * established convention wherever a file returns markup. See task report for
 * this and other minimal idiom-matching deviations.
 */
export interface WidgetDef {
  title: string
  component: React.ComponentType
}

// A literal (not a keyed map()) so TS verifies at compile time that every
// HomeWidgetId has an entry — a future 10th id added to HomeWidgetIdSchema
// (shared/src/types.ts) fails typecheck here instead of rendering a blank cell.
export const WIDGET_DEFS: Record<HomeWidgetId, WidgetDef> = {
  active_runs: { title: 'Active runs', component: ActiveRunsWidget },
  needs_you: { title: 'Needs you', component: NeedsYouWidget },
  org_glance: { title: 'Org at a glance', component: OrgGlanceWidget },
  recent_activity: { title: 'Recent activity', component: RecentActivityWidget },
  cost_today: { title: 'Cost today', component: CostTodayWidget },
  personal_tasks: { title: 'Personal tasks', component: PersonalTasksWidget },
  notes: { title: 'Notes', component: NotesWidget },
  schedule: { title: 'Schedule', component: ScheduleWidget },
  project_health: { title: 'Project health', component: ProjectHealthWidget },
}
