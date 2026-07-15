import { useQuery } from '@tanstack/react-query'
import type { AutonomySettings } from '@k/shared'
import { api } from '../lib/api'
import SegControl from '../components/SegControl'
import { navigate } from '../lib/route'
import RosterView from './org/RosterView'
import TreeView from './org/TreeView'
import GraphView from './org/GraphView'

type OrgSeg = 'roster' | 'tree' | 'graph'
const isSeg = (s: string | undefined): s is OrgSeg => s === 'roster' || s === 'tree' || s === 'graph'

// P5-B: a READ-ONLY status chip — the control itself lives in Settings → Autonomous
// Org (single source of truth, no duplicated toggle here).
function AutonomyStatusChip() {
  const { data } = useQuery<AutonomySettings>({ queryKey: ['autonomy'], queryFn: () => api.autonomy.get() })
  const on = data?.enabled === true
  return (
    <button
      type="button"
      data-testid="org-autonomy-chip"
      onClick={() => navigate('settings')}
      title={
        on
          ? 'Autonomous Org is ON — proposals, backlog pull and self-heal per Settings.'
          : 'Autonomous Org is OFF — the org acts only when you ask. Click to configure in Settings.'
      }
      className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
    >
      Autonomy: {on ? 'ON' : 'OFF'}
    </button>
  )
}

export default function OrgPage({ seg }: { seg?: string }) {
  const active: OrgSeg = isSeg(seg) ? seg : 'roster'
  return (
    <div data-testid="org-page" className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 px-5 pt-5">
        <h1 className="text-display text-text">Org</h1>
        <AutonomyStatusChip />
        <div className="ml-auto">
          <SegControl<OrgSeg>
            ariaLabel="Org view"
            options={[{ label: 'Roster', value: 'roster' }, { label: 'Tree', value: 'tree' }, { label: 'Graph', value: 'graph' }]}
            value={active}
            onChange={(s) => navigate('agents', 'org', s)}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {active === 'roster' && <RosterView />}
        {active === 'tree' && <TreeView />}
        {active === 'graph' && <GraphView />}
      </div>
    </div>
  )
}
