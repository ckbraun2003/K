import { useRef } from 'react'
import { navigate } from '../lib/route'
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const goTab = (id: TabId) => {
    const def = TABS.find(t => t.id === id)!
    navigate('skills', def.param)
  }

  // Roving-focus arrow-key navigation, mirroring ProjectWorkspace's tab bar.
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const count = TABS.length
    let next = idx
    if (e.key === 'ArrowRight') next = (idx + 1) % count
    else if (e.key === 'ArrowLeft') next = (idx - 1 + count) % count
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    goTab(TABS[next].id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Skills tabs"
        className="flex flex-wrap gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2"
      >
        {TABS.map((t, idx) => {
          const isActive = t.id === activeTab
          return (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              ref={el => { tabRefs.current[idx] = el }}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => goTab(t.id)}
              onKeyDown={e => handleTabKeyDown(e, idx)}
              data-testid={`skills-tab-${t.id}`}
              className={
                isActive
                  ? 'rounded-control border border-[color:rgba(255,143,192,0.3)] bg-[color:rgba(255,143,192,0.14)] px-3.5 py-1.5 text-xs font-medium text-[var(--text)] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-hover)]'
                  : 'rounded-control border border-transparent px-3.5 py-1.5 text-xs font-medium text-[var(--muted)] transition-all duration-150 hover:bg-[var(--raised)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-hover)]'
              }
            >
              {t.label}
            </button>
          )
        })}
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
            aria-labelledby={`tab-${t.id}`}
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
