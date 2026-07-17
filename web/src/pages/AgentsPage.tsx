import { useState } from 'react'
import Tabs from '../components/Tabs'
import SegControl from '../components/SegControl'
import { navigate } from '../lib/route'
import OrgPage from './OrgPage'
import CatalogPage from './CatalogPage'
import WorkflowsView from './runs/WorkflowsView'
import PipelinesView from './runs/PipelinesView'

/**
 * Agents hub — mirrors PersonalPage's shape. Three top tabs (orchestration-p2
 * Task B.4 IA redesign, design spec §2): Org (roster/tree/graph) / Catalog
 * (reusable building blocks — Skills/MCP/Hooks/Sub Agents, formerly the
 * "Skills" tab) / Automations (the unified pipeline surface — formerly
 * "Pipelines"/"Skills · Automations"; Lane C's Task C.4 replaces this tab's
 * body with the Library/Runs/Schedules AutomationsView — this tab keeps
 * mounting the pre-existing Pipelines/Workflows surface verbatim in the
 * interim so no deep link breaks before that lands).
 */
const TAB_IDS = ['org', 'catalog', 'automations'] as const
type AgentsTab = (typeof TAB_IDS)[number]

/**
 * The Automations tab (D-119 C3, pending Lane C's Task C.4 replacement): a
 * SegControl fronts the executable-pipelines surface (PipelinesView — run
 * entrance + live DAG) alongside the legacy Automations definitions surface
 * (WorkflowsView). A deep-linked definition id (`sub`) opens the legacy editor
 * directly, preserving every `navigate('agents','automations',<defId>)` link
 * (the definitions list's Open button, the workflow-detail redirects).
 */
function AutomationsPane({ defId }: { defId?: string }) {
  const [seg, setSeg] = useState<'pipelines' | 'automations'>('pipelines')
  // A definition deep-link is always the legacy single-template editor.
  if (defId) return <WorkflowsView defId={defId} />
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 px-1">
        <SegControl<'pipelines' | 'automations'>
          ariaLabel="Pipelines view"
          options={[
            { label: 'Pipelines', value: 'pipelines' },
            { label: 'Automations', value: 'automations' },
          ]}
          value={seg}
          onChange={setSeg}
        />
      </div>
      <div className="min-h-0 flex-1">{seg === 'pipelines' ? <PipelinesView /> : <WorkflowsView />}</div>
    </div>
  )
}

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
      {active === 'automations' && <AutomationsPane defId={sub} />}
    </div>
  )
}
