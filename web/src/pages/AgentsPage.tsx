import { useState } from 'react'
import Tabs from '../components/Tabs'
import SegControl from '../components/SegControl'
import { navigate } from '../lib/route'
import OrgPage from './OrgPage'
import SkillsPage from './SkillsPage'
import WorkflowsView from './runs/WorkflowsView'
import PipelinesView from './runs/PipelinesView'

/**
 * Agents hub (UI Simplification Task 16, fills the Task 10 stub) — mirrors
 * PersonalPage's shape. Merges Org (roster/tree/graph) + Skills
 * (catalog/MCP/hooks/automations) + Automations (named workflow definitions,
 * folded off Runs; visible label only — the route param stays `pipelines`
 * so `workflows→agents/pipelines` redirects keep working) under one tabbed
 * surface (Impressive Wave Task 10 Step 1: naming audit, Automations wins).
 */
const TAB_IDS = ['org', 'skills', 'pipelines'] as const
type AgentsTab = (typeof TAB_IDS)[number]

/**
 * The Pipelines tab (D-119 C3): a SegControl fronts the NEW executable-pipelines
 * surface (PipelinesView — run entrance + live DAG) alongside the legacy Automations
 * definitions surface (WorkflowsView). A deep-linked definition id (`sub`) opens the
 * legacy editor directly, preserving every `navigate('agents','pipelines',<defId>)`
 * link (the definitions list's Open button, the workflow-detail redirects).
 */
function PipelinesTab({ defId }: { defId?: string }) {
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
          { value: 'skills', label: 'Skills' },
          { value: 'pipelines', label: 'Automations' },
        ]}
        value={active}
        onChange={v => navigate('agents', v)}
        ariaLabel="Agents"
      />
      {active === 'org' && <OrgPage seg={sub} />}
      {active === 'skills' && <SkillsPage tab={sub} />}
      {active === 'pipelines' && <PipelinesTab defId={sub} />}
    </div>
  )
}
