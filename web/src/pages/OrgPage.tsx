import SegControl from '../components/SegControl'
import { navigate } from '../lib/route'
import RosterView from './org/RosterView'
import TreeView from './org/TreeView'
import GraphView from './org/GraphView'

type OrgSeg = 'roster' | 'tree' | 'graph'
const isSeg = (s: string | undefined): s is OrgSeg => s === 'roster' || s === 'tree' || s === 'graph'

export default function OrgPage({ seg }: { seg?: string }) {
  const active: OrgSeg = isSeg(seg) ? seg : 'roster'
  return (
    <div data-testid="org-page" className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 px-5 pt-5">
        <h1 className="text-sm font-semibold text-[var(--text)]">Org</h1>
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
