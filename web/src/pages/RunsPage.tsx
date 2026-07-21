import { navigate } from '../lib/route'
import RunList from '../components/RunList'
import RunConsole from '../components/RunConsole'
import { EmptyState } from '../ui/EmptyState'
import SegControl from '../components/SegControl'
import { PipelineRunsPane } from './runs/PipelinesView'

type RunsSeg = 'agent' | 'pipelines'

function RunsMasterDetail({ runId }: { runId?: string }) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* NOT glass-chrome — this scrolls dense run-list data, so it stays an
          opaque surface (bg-surface, no blur/radius/all-side border — a flush
          full-height divider, not a floating card) per "dense data never sits
          on blur". */}
      <aside className="bg-surface w-72 flex-shrink-0 overflow-hidden border-r border-border">
        <RunList selectedId={runId ?? null} onSelect={id => navigate('runs', id)} />
      </aside>
      {/* section, not main — the shell already provides the page's <main> landmark */}
      <section className="min-w-0 flex-1 overflow-hidden">
        {runId ? (
          <RunConsole runId={runId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon="runs" headline="Select a run" hint="or press ⌘K to dispatch one" />
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Lane B (runs consolidation): a top-level segmented control — "Agent Runs" (the
 * original master/detail console) vs "Pipelines" (relocated here from Automations'
 * old Runs segment — B1). `param` doubles as BOTH the segment keyword ('pipelines')
 * and, on the Agent Runs segment, the selected run id — mirroring how route.ts
 * already reserves 'workflows' as a runs-param keyword. `subParam` carries the
 * selected pipeline run id on the Pipelines segment.
 */
export default function RunsPage({ param, subParam }: { param?: string; subParam?: string }) {
  const seg: RunsSeg = param === 'pipelines' ? 'pipelines' : 'agent'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 px-1 pt-2">
        <SegControl<RunsSeg>
          ariaLabel="Runs view"
          options={[
            { label: 'Agent Runs', value: 'agent' },
            { label: 'Pipelines', value: 'pipelines' },
          ]}
          value={seg}
          onChange={v => navigate('runs', v === 'pipelines' ? 'pipelines' : undefined)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {seg === 'agent' ? (
          <RunsMasterDetail runId={param} />
        ) : (
          <div className="h-full overflow-y-auto px-4 pb-4">
            <PipelineRunsPane
              selectedRunId={subParam}
              onSelectRun={id => navigate('runs', 'pipelines', id)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
