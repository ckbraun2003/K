import Tabs from '../components/Tabs'
import { navigate } from '../lib/route'
import OrgPage from './OrgPage'
import CatalogPage from './CatalogPage'
import AutomationsView from './runs/AutomationsView'

/**
 * Agents hub — mirrors PersonalPage's shape. Three top tabs (orchestration-p2
 * Task B.4 IA redesign, design spec §2): Org (roster/tree/graph) / Catalog
 * (the reusable building blocks — Skills/MCP/Hooks/Sub Agents, formerly the
 * "Skills" tab) / Automations (the unified pipeline surface — Library/Runs/
 * Schedules, Lane C Task C.4's AutomationsView, formerly "Pipelines"). The
 * Catalog sub-tab and the Automations definition id both ride the `sub` route
 * param; legacy `agents/skills/*` and `agents/pipelines/*` deep-links redirect
 * here (web/src/lib/route.ts).
 */
const TAB_IDS = ['org', 'catalog', 'automations'] as const
type AgentsTab = (typeof TAB_IDS)[number]

export default function AgentsPage({ tab, sub }: { tab?: string; sub?: string }) {
  const active: AgentsTab = (TAB_IDS as readonly string[]).includes(tab ?? '') ? (tab as AgentsTab) : 'org'
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Tabs
        items={[
          { value: 'org', label: 'Org' },
          { value: 'catalog', label: 'Catalog' },
          { value: 'automations', label: 'Automations' },
        ]}
        value={active}
        onChange={v => navigate('agents', v)}
        ariaLabel="Agents"
      />
      {active === 'org' && <OrgPage seg={sub} />}
      {active === 'catalog' && <CatalogPage tab={sub} />}
      {active === 'automations' && <AutomationsView defId={sub} />}
    </div>
  )
}
