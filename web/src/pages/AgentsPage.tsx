import Tabs from '../components/Tabs'
import { navigate } from '../lib/route'
import OrgPage from './OrgPage'
import SkillsPage from './SkillsPage'
import AutomationsView from './runs/AutomationsView'

/**
 * Agents hub (UI Simplification Task 16, fills the Task 10 stub) — mirrors
 * PersonalPage's shape. Merges Org (roster/tree/graph) + Skills
 * (catalog/MCP/hooks) + Automations (executable pipelines — Library/Runs/
 * Schedules, orch-p2 C.4; visible label only — the route param stays
 * `pipelines` so `workflows→agents/pipelines` redirects keep working) under
 * one tabbed surface (Impressive Wave Task 10 Step 1: naming audit, Automations
 * wins).
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
          { value: 'pipelines', label: 'Automations' },
        ]}
        value={active}
        onChange={v => navigate('agents', v)}
        ariaLabel="Agents"
      />
      {active === 'org' && <OrgPage seg={sub} />}
      {active === 'skills' && <SkillsPage tab={sub} />}
      {active === 'pipelines' && <AutomationsView defId={sub} />}
    </div>
  )
}
