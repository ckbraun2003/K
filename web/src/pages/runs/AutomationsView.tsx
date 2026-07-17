import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RoutineView } from '@k/shared'
import { api } from '../../lib/api'
import SegControl from '../../components/SegControl'
import Toast from '../../components/Toast'
import { PipelineLibraryPane, PipelineRunsPane } from './PipelinesView'
import { SectionHeader } from '../../ui/SectionHeader'
import { Tag } from '../../ui/Tag'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonTile } from '../../ui/Skeleton'

type AutomationsSeg = 'library' | 'runs' | 'schedules'

/**
 * The Schedules pane (orch-p2 C.4, design §9) — routines that target a pipeline
 * definition (`pipelineDefId` set). `core/src/routes/routines.ts` (routines.ts:25)
 * populates `pipelineDefId` from `skills.pipeline_def_id`, so this pane lists every
 * schedule-triggered routine pinned to a pipeline; a routine with no pipeline target
 * is filtered out, and an empty result renders an honest empty state.
 */
function SchedulesPane() {
  const { data: routines, isLoading, isError, refetch } = useQuery<RoutineView[]>({
    queryKey: ['routines'],
    queryFn: () => api.routines.list(),
  })
  const scheduled = (routines ?? []).filter(r => r.pipelineDefId != null)

  return (
    <section className="surface-solid rounded-panel p-4">
      <SectionHeader label="Schedules" count={scheduled.length} />
      {isLoading ? (
        <SkeletonTile tier="solid" />
      ) : isError ? (
        <ErrorState message="Failed to load schedules." onRetry={() => void refetch()} />
      ) : scheduled.length === 0 ? (
        <div data-testid="automations-schedules-empty">
          <EmptyState
            tier="solid"
            icon="timeline"
            headline="No scheduled pipelines yet"
            hint="Routines targeting a pipeline appear here once scheduled."
          />
        </div>
      ) : (
        <ul className="space-y-1" data-testid="automations-schedules-list">
          {scheduled.map(r => (
            <li
              key={r.id}
              data-testid={`automations-schedule-${r.id}`}
              className="rounded-control border border-border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{r.name}</span>
                <Tag tint={r.enabled ? 'accent' : 'neutral'} className="flex-shrink-0 text-micro uppercase tracking-wide">
                  {r.enabled ? 'enabled' : 'disabled'}
                </Tag>
              </div>
              <span className="mono mt-0.5 block text-micro text-muted">{r.schedule}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The unified Automations surface (orch-p2 C.4, design §9/§6) — Library | Runs |
 * Schedules, replacing the SegControl toggle that used to sit directly in
 * AgentsPage's Pipelines tab (Pipelines-vs-legacy-Automations, PipelinesView vs
 * WorkflowsView). A definition deep-link (`defId`, e.g. AgentsPage's `sub` route
 * param) pins the surface to the Library segment with that definition's inspector
 * expanded — mirroring the old always-legacy-editor deep-link, so every existing
 * `navigate('agents','pipelines',<defId>)` link (route.ts's `workflow-detail` /
 * `workflows` redirects, the definitions list's Open button) keeps working.
 *
 * `WorkflowsView` (the legacy named-workflow editor) has been DELETED — this
 * surface fully replaces it; no reference to it remains.
 */
export default function AutomationsView({ defId }: { defId?: string }) {
  const [seg, setSeg] = useState<AutomationsSeg>('library')
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  const [toastRunId, setToastRunId] = useState<string | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 px-1">
        <SegControl<AutomationsSeg>
          ariaLabel="Automations view"
          options={[
            { label: 'Library', value: 'library' },
            { label: 'Runs', value: 'runs' },
            { label: 'Schedules', value: 'schedules' },
          ]}
          value={seg}
          onChange={setSeg}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {seg === 'library' && (
          <PipelineLibraryPane
            focusDefId={defId}
            onDispatched={runId => {
              setSelectedRunId(runId)
              setToastRunId(runId)
              setSeg('runs')
            }}
          />
        )}
        {seg === 'runs' && <PipelineRunsPane selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />}
        {seg === 'schedules' && <SchedulesPane />}
      </div>

      <Toast
        open={toastRunId !== null}
        testid="pipeline-run-toast"
        kind="success"
        message="Pipeline dispatched"
        resetKey={toastRunId ?? undefined}
        onDismiss={() => setToastRunId(null)}
      />
    </div>
  )
}
