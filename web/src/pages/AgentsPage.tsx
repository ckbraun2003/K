import Tabs from '../components/Tabs'
import { navigate } from '../lib/route'
import OrgPage from './OrgPage'
import SkillsPage from './SkillsPage'
import WorkflowsView from './runs/WorkflowsView'

/**
 * Agents hub (UI Simplification Task 16, fills the Task 10 stub) — mirrors
 * PersonalPage's shape. Merges Org (roster/tree/graph) + Skills
 * (catalog/MCP/hooks/automations) + Pipelines (named workflow definitions,
 * folded off Runs) under one tabbed surface.
 */
const TAB_IDS = ['org', 'skills', 'pipelines'] as const
type AgentsTab = (typeof TAB_IDS)[number]

export default function AgentsPage({ tab, sub }: { tab?: string; sub?: string }) {
  const active: AgentsTab = (TAB_IDS as readonly string[]).includes(tab ?? '') ? (tab as AgentsTab) : 'org'
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Tabs
        items={[
          { value: 'org', label: 'Org' },
          { value: 'skills', label: 'Skills' },
          { value: 'pipelines', label: 'Pipelines' },
        ]}
        value={active}
        onChange={v => navigate('agents', v)}
        ariaLabel="Agents"
      />
      {active === 'org' && <OrgPage seg={sub} />}
      {active === 'skills' && <SkillsPage tab={sub} />}
      {active === 'pipelines' && <WorkflowsView defId={sub} />}
    </div>
  )
}
