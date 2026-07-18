import type { PipelineSpec, PipelineRunView, PipelineRun, PipelineStageRun, PipelineEdgeView } from '@k/shared'

/**
 * Adapts a design-time `PipelineSpec` (a pipeline *definition*, not a run) into the
 * `PipelineRunView` shape `PipelineGraph` already renders, so the definition
 * inspector can show the same visual DAG as a live run — every stage forced to
 * `'pending'` (no run has started), edges mapped 1:1. `run` is a minimal
 * type-satisfying stub; `PipelineGraph`/`layoutPipeline` never read it (they only
 * consume `stages`/`edges`).
 *
 * Note: `PipelineStageRunSchema.attempt`/`maxAttempts` are non-nullable numbers
 * (not `number | null`), so they can't be set to `null` to suppress the node's
 * "attempt x/y" line — `attempt: 0` (nothing attempted yet) and `maxAttempts` taken
 * from the stage's own retry policy are the closest honest "not started" values.
 * `costUsd` IS nullable and is left `null`, so the node's cost segment stays hidden.
 */
export function previewViewFromSpec(spec: PipelineSpec): PipelineRunView {
  const run: PipelineRun = {
    id: 'preview',
    definitionId: null,
    projectId: null,
    title: spec.name,
    // PipelineRunStatusSchema has no "not started"/"draft" member — 'running' is
    // the closest fit among {running, completed, failed, cancelled}. PipelineGraph
    // never reads `run` (it only reads `stages`/`edges`), so this is a pure
    // type-satisfying stub, not a claim that anything is actually running.
    status: 'running',
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ownerProfileId: null,
  }

  const stages: PipelineStageRun[] = spec.stages.map(stage => ({
    id: stage.id,
    pipelineRunId: 'preview',
    stageKey: stage.id,
    kind: stage.kind,
    status: 'pending',
    // `canonical` is optional — omitted so stageCanonical() derives it from
    // `status: 'pending'` (canonicalizePipelineStageStatus), matching a real
    // not-yet-dispatched stage rather than asserting a fake canonical state.
    runId: null,
    attempt: 0,
    maxAttempts: stage.retry.maxAttempts,
    repairs: 0,
    costUsd: null,
    failureClass: null,
    gateNote: null,
    baseCommit: null,
    resultCommit: null,
    startedAt: null,
    completedAt: null,
  }))

  const edges: PipelineEdgeView[] = spec.edges.map(edge => ({
    from: edge.from,
    to: edge.to,
    handoff: edge.handoff,
    when: edge.when,
  }))

  return { run, stages, edges }
}
