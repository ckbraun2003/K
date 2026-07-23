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
      {/* Round 2 (Lane B): glass tint, not the old opaque bg-surface — the D-133
          "dense data never sits on blur" rule that motivated the opaque surface no
          longer applies: the glass tiers are opacity-tint ONLY (no backdrop-filter)
          as of Round 2, so a scrolling list of run rows costs exactly what a plain
          div would. bg-[var(--glass-2)] rather than the .glass-panel/.glass-chrome
          CLASS — those bundle an all-sided border + radius + shadow for a floating
          card, but this aside stays a flush full-height divider (border-r only). */}
      <aside className="bg-[var(--glass-2)] w-72 flex-shrink-0 overflow-hidden border-r border-border">
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
