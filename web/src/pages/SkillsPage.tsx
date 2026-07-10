import { navigate } from '../lib/route'
import Tabs from '../components/Tabs'
import CapabilityStatRow from '../components/CapabilityStatRow'
import CatalogTab from './skills/CatalogTab'
import McpTab from './skills/McpTab'
import HooksTab from './skills/HooksTab'
import AutomationsTab from './skills/AutomationsTab'

// The Skills destination (wave C2) — ONE sidebar entry, four routed tabs:
//   #/skills             → Catalog (default): the unified capability catalog (D-069)
//   #/skills/mcp         → MCP servers with trust gating (D-070)
//   #/skills/hooks       → host-hook visibility (read-only by scope decision)
//   #/skills/automations → the pre-existing K automation registry, verbatim
// Tabs follow ProjectWorkspace's tablist pattern (roles + arrow-key nav); the
// CapabilityStatRow renders above every tab so context cost is always in view.

const TABS = [
  { id: 'catalog', label: 'Catalog', param: undefined },
  { id: 'mcp', label: 'MCP', param: 'mcp' },
  { id: 'hooks', label: 'Hooks', param: 'hooks' },
  { id: 'automations', label: 'Automations', param: 'automations' },
] as const

type TabId = typeof TABS[number]['id']

/** Route param → tab. No/unknown param lands on the Catalog (the default view). */
function tabFromParam(param: string | undefined): TabId {
  const hit = TABS.find(t => t.param === param)
  return hit ? hit.id : 'catalog'
}

export default function SkillsPage({ tab }: { tab?: string }) {
  const activeTab = tabFromParam(tab)

  const goTab = (id: TabId) => {
    const def = TABS.find(t => t.id === id)!
    navigate('skills', def.param)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Tab bar (canonical Tabs — E-30) ───────────────────────────────── */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <Tabs<TabId>
          ariaLabel="Skills"
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
                {t.id === 'catalog' && <CatalogTab />}
                {t.id === 'mcp' && <McpTab />}
                {t.id === 'hooks' && <HooksTab />}
                {t.id === 'automations' && <AutomationsTab />}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
