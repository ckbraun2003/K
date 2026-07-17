import { navigate } from '../lib/route'
import Tabs from '../components/Tabs'
import CapabilityStatRow from '../components/CapabilityStatRow'
import CatalogTab from './skills/CatalogTab'
import McpTab from './skills/McpTab'
import HooksTab from './skills/HooksTab'
import SubAgentsTab from './catalog/SubAgentsTab'

// The Catalog destination (orchestration-p2 Task B.4, renamed from SkillsPage) —
// one Agents-hub tab, routed sub-tabs:
//   #/agents/catalog          → Skills (default): the unified capability catalog (D-069)
//   #/agents/catalog/mcp      → MCP servers with trust gating (D-070)
//   #/agents/catalog/hooks    → host-hook visibility (read-only by scope decision)
//   #/agents/catalog/sub-agents → the dispatchable worker-bee registry (Task B.5)
//
// The old 4th "Automations" sub-tab (the pre-catalog K automation registry —
// skills/hooks/workflows with schedule/event triggers) is RETIRED from Catalog
// by the IA redesign (design §2.3): it was the "workflow-skills surface", and
// its routes now redirect into the top-level Automations tab (route.ts) rather
// than a Catalog sub-tab. Its standalone component (skills/AutomationsTab.tsx)
// is left in place — not deleted here — since it still has its own dedicated
// test files and Lane C's Task C.4 migrates its data/affordances into the new
// Automations surface's Schedules pane.
//
// Tabs follow ProjectWorkspace's tablist pattern (roles + arrow-key nav); the
// CapabilityStatRow renders above every tab so context cost is always in view.

const TABS = [
  { id: 'skills', label: 'Skills', param: undefined },
  { id: 'mcp', label: 'MCP', param: 'mcp' },
  { id: 'hooks', label: 'Hooks', param: 'hooks' },
  { id: 'sub-agents', label: 'Sub Agents', param: 'sub-agents' },
] as const

type TabId = typeof TABS[number]['id']

/** Route param → tab. No/unknown param lands on the Skills tab (the default view). */
function tabFromParam(param: string | undefined): TabId {
  const hit = TABS.find(t => t.param === param)
  return hit ? hit.id : 'skills'
}

export default function CatalogPage({ tab }: { tab?: string }) {
  const activeTab = tabFromParam(tab)

  const goTab = (id: TabId) => {
    const def = TABS.find(t => t.id === id)!
    navigate('agents', 'catalog', def.param)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Tab bar (canonical Tabs — E-30) ───────────────────────────────── */}
      <div className="border-b border-border bg-surface px-4 py-2">
        <Tabs<TabId>
          ariaLabel="Catalog"
          items={TABS.map(t => ({ value: t.id, label: t.label }))}
          value={activeTab}
          onChange={goTab}
        />
      </div>

      {/* ── Capability cost strip — on EVERY tab. ─────────────────────────── */}
      <CapabilityStatRow />

      {/* ── Tab panels ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {TABS.map(t => (
          <div
            key={t.id}
            id={`tabpanel-${t.id}`}
            role="tabpanel"
            aria-label={t.label}
            hidden={t.id !== activeTab}
            className="h-full"
          >
            {t.id === activeTab && (
              <>
                {t.id === 'skills' && <CatalogTab />}
                {t.id === 'mcp' && <McpTab />}
                {t.id === 'hooks' && <HooksTab />}
                {t.id === 'sub-agents' && <SubAgentsTab />}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
