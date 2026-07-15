// web/src/help/pages/index.tsx — HELP_PAGES barrel (FE-6).
// NOTE: named .tsx (brief said .ts) — a .ts file cannot contain JSX, which
// the HELP_PAGES entries below require. Deviation is load-bearing, not stylistic.
import type { ReactNode } from 'react'
import { Welcome } from './Welcome'
import { MessagingK } from './MessagingK'
import { RunsReview } from './RunsReview'
import { ProjectsBibles } from './ProjectsBibles'
import { AgentsOrg } from './AgentsOrg'
import { InsightsBudget } from './InsightsBudget'
import { SettingsShortcuts } from './SettingsShortcuts'

export interface HelpPage {
  id: string
  title: string
  body: ReactNode
}

export const HELP_PAGES: HelpPage[] = [
  { id: 'welcome', title: 'Welcome to K', body: <Welcome /> },
  { id: 'messaging', title: 'Messaging K & dispatching', body: <MessagingK /> },
  { id: 'runs', title: 'Runs & reviewing changes', body: <RunsReview /> },
  { id: 'projects', title: 'Projects, bibles & artifacts', body: <ProjectsBibles /> },
  { id: 'agents', title: 'Agents & the org', body: <AgentsOrg /> },
  { id: 'insights', title: 'Insights & budget', body: <InsightsBudget /> },
  { id: 'settings', title: 'Settings & shortcuts', body: <SettingsShortcuts /> },
]
