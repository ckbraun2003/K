import { useState } from 'react'
import Tabs, { type TabItem } from '../components/Tabs'
import SegControl from '../components/SegControl'
import { navigate } from '../lib/route'
import OverviewTab from './insights/OverviewTab'
import ChartsTab from './insights/ChartsTab'
import RoutingTab from './insights/RoutingTab'
import EvalsTab from './insights/EvalsTab'

type InsightsTab = 'overview' | 'charts' | 'routing' | 'evals'
type Days = 14 | 30 | 60

const TABS: TabItem<InsightsTab>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'charts', label: 'Charts' },
  { value: 'routing', label: 'Routing' },
  { value: 'evals', label: 'Evals' },
]
const isTab = (t: string | undefined): t is InsightsTab =>
  t === 'overview' || t === 'charts' || t === 'routing' || t === 'evals'

export default function InsightsPage({ tab }: { tab?: string }) {
  const active: InsightsTab = isTab(tab) ? tab : 'overview'
  // Shared cross-filter window across Overview/Charts/Routing (Evals is independent).
  const [days, setDays] = useState<Days>(14)
  return (
    <div data-testid="insights-page" className="h-full overflow-y-auto p-5">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-semibold text-[var(--text)]">Insights</h1>
        {active !== 'evals' && (
          <div className="ml-auto">
            {/* SegControl is generic over a STRING union (W0 frozen contract), so the numeric
                window is carried as a string here and coerced back to Days for the tabs. */}
            <SegControl<string>
              ariaLabel="Window"
              options={[{ label: '14d', value: '14' }, { label: '30d', value: '30' }, { label: '60d', value: '60' }]}
              value={String(days)}
              onChange={v => setDays(Number(v) as Days)}
            />
          </div>
        )}
      </header>
      <Tabs<InsightsTab> items={TABS} value={active} onChange={(t) => navigate('insights', t)} ariaLabel="Insights sections" />
      <div className="mt-4">
        {active === 'overview' && <OverviewTab days={days} />}
        {active === 'charts' && <ChartsTab days={days} />}
        {active === 'routing' && <RoutingTab days={days} />}
        {active === 'evals' && <EvalsTab />}
      </div>
    </div>
  )
}
