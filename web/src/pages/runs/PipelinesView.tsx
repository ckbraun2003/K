import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  canonicalizePipelineRunStatus,
  type PipelineRun,
  type PipelineRunView,
  type PipelineStageRun,
  type Project,
} from '@k/shared'
import type { PipelineDefSummary } from '../../lib/api'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import PipelineGraph from '../../components/PipelineGraph'
import PipelineStageCard from '../../components/PipelineStageCard'
import PipelineGateDialog from '../../components/PipelineGateDialog'
import PipelineDefInspector from '../../components/PipelineDefInspector'
import PipelineLedgerPanel from '../../components/PipelineLedgerPanel'
import { StatusPill } from '../../ui/StatusPill'
import { SectionHeader } from '../../ui/SectionHeader'
import { Button } from '../../ui/Button'
import { Tag } from '../../ui/Tag'
import { Select, Textarea } from '../../ui/Field'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonTile } from '../../ui/Skeleton'

/** Non-terminal pipeline run statuses — a Cancel button only makes sense while live. */
const LIVE_RUN = new Set(['running'])

function runTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/**
 * The "Run pipeline" launcher (mirrors WorkflowsView's RunWorkflowDialog): pick a
 * definition, type a goal, optionally scope to a project → `api.pipelines.run`. The
 * new pipeline-run id is reported up via `onDispatched` so the page selects it + toasts.
 */
function RunPipelineDialog({
  open,
  defs,
  onClose,
  onDispatched,
}: {
  open: boolean
  defs: PipelineDefSummary[]
  onClose: () => void
  onDispatched: (pipelineRunId: string) => void
}) {
  const [defId, setDefId] = useState('')
  const [goal, setGoal] = useState('')
  const [projectId, setProjectId] = useState('')

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
    enabled: open,
  })

  const dispatch = useMutation({
    mutationFn: () => api.pipelines.run(defId, { goal: goal.trim(), projectId: projectId || undefined }),
    onSuccess: r => onDispatched(r.pipelineRunId),
  })

  // Reset each open; default the definition to the first available.
  useEffect(() => {
    if (!open) return
    setGoal('')
    setProjectId('')
    setDefId(defs[0]?.id ?? '')
    dispatch.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o && !dispatch.isPending) onClose()
      }}
      title="Run pipeline"
      footer={
        <>
          <Button variant="ghost" size="sm" className="border border-border" disabled={dispatch.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="bolt"
            data-testid="pipeline-run-fire"
            loading={dispatch.isPending}
            disabled={defId === '' || goal.trim() === ''}
            onClick={() => dispatch.mutate()}
          >
            Run
          </Button>
        </>
      }
    >
      <div data-testid="pipeline-run-dialog" className="space-y-3">
        <div>
          <label className="mb-1 block text-caption text-muted">Pipeline</label>
          {defs.length === 0 ? (
            <p className="text-label italic text-muted">No pipelines available.</p>
          ) : (
            <Select
              data-testid="pipeline-run-def"
              aria-label="Pipeline"
              value={defId}
              onChange={e => setDefId(e.target.value)}
              className="w-full text-label"
            >
              {defs.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div>
          <label className="mb-1 block text-caption text-muted">Goal</label>
          <Textarea
            data-testid="pipeline-run-goal"
            aria-label="Goal"
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="What should this pipeline accomplish?"
            className="w-full"
          />
        </div>

        <div>
          <label className="mb-1 block text-caption text-muted">Project (optional)</label>
          <Select
            data-testid="pipeline-run-project"
            aria-label="Project"
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            className="w-full text-label"
          >
            <option value="">No project</option>
            {(projects ?? []).map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        {dispatch.isError && (
          <p data-testid="pipeline-run-error" className="text-label text-red">
            {(dispatch.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** The selected pipeline run's live detail — the DAG + a stage list + Cancel. */
function RunDetail({ runId }: { runId: string }) {
  const qc = useQueryClient()
  const [selectedStageKey, setSelectedStageKey] = useState<string | undefined>(undefined)
  const [gateStage, setGateStage] = useState<PipelineStageRun | null>(null)

  const { data: view, isLoading, isError, refetch } = useQuery<PipelineRunView>({
    queryKey: ['pipeline-run', runId],
    queryFn: () => api.pipelines.getRun(runId),
  })

  // A mutation (rewind / gate / cancel) returns the refreshed view — write it straight
  // into the cache so the DAG + cards update without a round-trip. Live WS deltas land
  // here too via the app-wide makePipelineInvalidator (setQueryData on the same key).
  const applyView = (next: PipelineRunView) => {
    qc.setQueryData(['pipeline-run', runId], next)
    void qc.invalidateQueries({ queryKey: ['pipeline-runs'] })
  }

  const cancel = useMutation({
    mutationFn: () => api.pipelines.cancel(runId),
    onSuccess: applyView,
  })

  if (isLoading) return <SkeletonTile tier="solid" />
  if (isError || !view) return <ErrorState message="Failed to load the pipeline run." onRetry={() => void refetch()} />

  const { run, stages } = view
  const live = LIVE_RUN.has(run.status)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-title">{run.title}</h2>
        <StatusPill
          canonical={canonicalizePipelineRunStatus(run.status)}
          label={run.status}
          className="flex-shrink-0"
        />
        {live && (
          <Button
            variant="danger"
            size="sm"
            icon="stop"
            data-testid="pipeline-cancel"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        )}
      </div>

      {cancel.isError && <p className="text-caption text-red">{(cancel.error as Error).message}</p>}

      <div className="surface-solid rounded-panel p-3">
        <PipelineGraph view={view} selectedStageKey={selectedStageKey} onSelectStage={setSelectedStageKey} />
      </div>

      <div className="space-y-2">
        <SectionHeader label="Stages" count={stages.length} as="h3" />
        {stages.map(stage => (
          <PipelineStageCard
            key={stage.id}
            stage={stage}
            runId={runId}
            selected={stage.stageKey === selectedStageKey}
            onSelect={setSelectedStageKey}
            onReviewGate={setGateStage}
            onView={applyView}
          />
        ))}
      </div>

      <div className="surface-solid rounded-panel p-3">
        <PipelineLedgerPanel runId={runId} />
      </div>

      <PipelineGateDialog
        open={gateStage !== null}
        runId={runId}
        stage={gateStage}
        onClose={() => setGateStage(null)}
        onResolved={applyView}
        onConflict={() => void refetch()}
      />
    </div>
  )
}

/**
 * The pipeline LIBRARY pane (orch-p2 C.4 — extracted out of the original combined
 * PipelinesView so `AutomationsView` can host it as its own segment): a definitions
 * list, an inspector on select (deep-linkable via `focusDefId`), and the "Run
 * pipeline" launcher. `onDispatched` reports the new run id up to the caller —
 * this pane doesn't own run selection or the runs list, only dispatch.
 */
export function PipelineLibraryPane({
  focusDefId,
  onDispatched,
}: {
  /** Deep-link (e.g. AgentsPage's `sub` param) — expands that def's inspector on mount. */
  focusDefId?: string
  onDispatched?: (pipelineRunId: string) => void
}) {
  const [inspectDefId, setInspectDefId] = useState<string | undefined>(focusDefId)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const qc = useQueryClient()

  const defsQ = useQuery<PipelineDefSummary[]>({
    queryKey: ['pipeline-defs'],
    queryFn: () => api.pipelines.list(),
  })
  const defs = defsQ.data ?? []

  return (
    <section className="surface-solid rounded-panel p-4">
      <SectionHeader
        label="Pipelines"
        count={defs.length}
        action={
          <Button
            variant="primary"
            size="sm"
            icon="bolt"
            data-testid="pipeline-run-open"
            disabled={defs.length === 0}
            onClick={() => setLauncherOpen(true)}
          >
            Run pipeline
          </Button>
        }
      />
      {defsQ.isLoading ? (
        <SkeletonTile tier="solid" />
      ) : defsQ.isError ? (
        <ErrorState message="Failed to load pipelines." onRetry={() => void defsQ.refetch()} />
      ) : defs.length === 0 ? (
        <EmptyState
          tier="solid"
          icon="bolt"
          headline="No pipelines yet"
          hint="Executable pipelines appear here once a definition is seeded."
        />
      ) : (
        <ul className="space-y-1" data-testid="pipeline-def-list">
          {defs.map(def => (
            <li
              key={def.id}
              className="rounded-control border border-border px-3 py-2"
              data-testid={`pipeline-def-${def.id}`}
            >
              <button
                type="button"
                className="w-full text-left"
                data-testid={`pipeline-def-inspect-${def.id}`}
                disabled={!def.hasSpec}
                onClick={() => setInspectDefId(id => (id === def.id ? undefined : def.id))}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{def.name}</span>
                  {def.hasSpec && (
                    <Tag tint="accent" className="flex-shrink-0 text-micro uppercase tracking-wide">
                      spec
                    </Tag>
                  )}
                </div>
                {def.description && <p className="mt-0.5 truncate text-caption text-muted">{def.description}</p>}
              </button>
              {inspectDefId === def.id && (
                <div className="mt-3 border-t border-border pt-3">
                  <PipelineDefInspector defId={def.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <RunPipelineDialog
        open={launcherOpen}
        defs={defs}
        onClose={() => setLauncherOpen(false)}
        onDispatched={runId => {
          setLauncherOpen(false)
          void qc.invalidateQueries({ queryKey: ['pipeline-runs'] })
          onDispatched?.(runId)
        }}
      />
    </section>
  )
}

/**
 * The pipeline RUNS pane (orch-p2 C.4 — the other half of the original PipelinesView):
 * the recent-runs list plus the selected run's live DAG detail. A controlled
 * component — `AutomationsView` lifts `selectedRunId` so a Library dispatch can
 * switch segments and land the caller straight on the new run.
 */
export function PipelineRunsPane({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | undefined
  onSelectRun: (runId: string) => void
}) {
  const runsQ = useQuery<PipelineRun[]>({
    queryKey: ['pipeline-runs'],
    queryFn: () => api.pipelines.listRuns(30),
  })
  const runs = runsQ.data ?? []

  // Default the selection to the most recent run once the list arrives.
  useEffect(() => {
    if (!selectedRunId && runsQ.data && runsQ.data.length > 0) onSelectRun(runsQ.data[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsQ.data, selectedRunId])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
      <section className="surface-solid rounded-panel p-4">
        <SectionHeader label="Recent runs" count={runs.length} />
        {runsQ.isLoading ? (
          <SkeletonTile tier="solid" />
        ) : runsQ.isError ? (
          <ErrorState message="Failed to load pipeline runs." onRetry={() => void runsQ.refetch()} />
        ) : runs.length === 0 ? (
          <EmptyState tier="solid" icon="runs" headline="No pipeline runs yet" hint="Launch one to see it here." />
        ) : (
          <ul className="space-y-1" data-testid="pipeline-run-list">
            {runs.map(run => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                  aria-pressed={run.id === selectedRunId}
                  data-testid={`pipeline-run-row-${run.id}`}
                  className={cn(
                    'w-full rounded-control border px-3 py-2 text-left transition-colors',
                    run.id === selectedRunId ? 'border-accent bg-raised' : 'border-border hover:border-border-strong',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-label font-medium text-text">{run.title}</span>
                    <StatusPill
                      canonical={canonicalizePipelineRunStatus(run.status)}
                      label={run.status}
                      className="flex-shrink-0"
                    />
                  </div>
                  <span className="mono mt-0.5 block text-micro text-muted">{runTime(run.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="min-w-0">
        {selectedRunId ? (
          <RunDetail runId={selectedRunId} />
        ) : (
          <div className="surface-solid rounded-panel">
            <EmptyState
              tier="solid"
              icon="runs"
              headline="No run selected"
              hint={runs.length === 0 ? 'Launch a pipeline to get started.' : 'Pick a run to see its live DAG.'}
            />
          </div>
        )}
      </div>
    </div>
  )
}
