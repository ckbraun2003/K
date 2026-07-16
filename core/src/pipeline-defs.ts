/**
 * Pipeline instantiation + the delegation seam (D-119 Lane A, wave A3).
 *
 * `instantiatePipeline` MATERIALIZES a frozen PipelineSpec into the runtime ledger: one
 * `pipeline_runs` row (its `base_commit` snapshots `cwd`'s HEAD — the fork point every
 * per-edge handoff computes bases from) plus one `pipeline_stages` row per stage (the
 * StageDef object frozen as `spec` JSON) and one `pipeline_edges` row per edge. The
 * scheduler (`pipeline-scheduler.ts`) then walks it — nothing here dispatches.
 *
 * `startPipelineRun` is the ENGINE SEAM both delegation entrances funnel through (§3):
 * the operator's `POST /api/pipelines/:id/run` (in-process, C-later) and K/Chief's
 * `delegate_pipeline` → `pipeline-dispatch-relay` (C1). It resolves a PipelineSpec — from
 * `workflow_definitions.spec` by id, or a spec object passed directly (tests / ad-hoc) —
 * instantiates it, and lets the scheduler's interval pick up the new running pipeline.
 *
 * Seeding the 3 reference pipelines (code-wave/investigate/refactor) into
 * workflow_definitions.spec is Lane B (B1); A3 provides only the pipes.
 */

import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { PipelineSpecSchema, namedWorkflowToPipeline, type PipelineSpec, type StageDef } from '@k/shared'
import { pipelineDb, workflowDefsDb, rowToNamedWorkflow } from './db.js'

/** Snapshot `cwd`'s HEAD as the pipeline's base_commit. FAIL-CLOSED: a non-git cwd (or a
 *  repo with no commits) throws, so a pipeline is never instantiated against a tree the
 *  handoff can't fork from. Sync so instantiatePipeline stays a single synchronous unit. */
function resolveHeadCommit(cwd: string): string {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`instantiatePipeline: cwd is not a git repo (git rev-parse HEAD failed): ${cwd}`)
  }
}

/** The seeded profile a stage carries at instantiation (the executor still falls back to
 *  the role → profile map when this is null). Agent stages carry their explicit profileId;
 *  a hook-agent carries the hook's profileId; every other kind has no profile. */
function stageProfileId(stage: StageDef): string | null {
  if (stage.kind === 'agent') return stage.profileId ?? null
  if (stage.kind === 'hook' && stage.hook.type === 'agent') return stage.hook.profileId
  return null
}

export interface InstantiateOptions {
  cwd: string
  goal: string
  projectId?: string | null
  /** The pipeline_runs title `{{GOAL}}` renders from; defaults to `goal`. */
  title?: string
  /** The workflow_definitions template this was instantiated from (loose ref, no FK). */
  definitionId?: string | null
}

/**
 * Materialize `spec` into `pipeline_runs` + `pipeline_stages` + `pipeline_edges`. Returns
 * the new pipelineRunId. The stage `spec` column stores the StageDef verbatim (the executor
 * re-validates it with StageDefSchema); `repair_stage_key` seeds A4's routing target.
 */
export function instantiatePipeline(spec: PipelineSpec, opts: InstantiateOptions): string {
  const baseCommit = resolveHeadCommit(opts.cwd)
  const pipelineRunId = randomUUID()
  const now = Date.now()

  pipelineDb.insertPipelineRun.run({
    id: pipelineRunId,
    definitionId: opts.definitionId ?? null,
    projectId: opts.projectId ?? null,
    title: opts.title ?? opts.goal,
    cwd: opts.cwd,
    baseCommit,
    createdAt: now,
    updatedAt: now,
  })

  for (const stage of spec.stages) {
    pipelineDb.insertStage.run({
      id: randomUUID(),
      pipelineRunId,
      stageKey: stage.id,
      kind: stage.kind,
      profileId: stageProfileId(stage),
      spec: JSON.stringify(stage),
      baseCommit: null, // computed per-edge at dispatch (pipeline-handoff.ts)
      repairStageKey: stage.repair?.toStage ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  for (const edge of spec.edges) {
    pipelineDb.insertEdge.run({
      id: randomUUID(),
      pipelineRunId,
      fromStageKey: edge.from,
      toStageKey: edge.to,
      handoff: edge.handoff,
      whenCond: edge.when,
    })
  }

  return pipelineRunId
}

/**
 * Resolve a workflow_definitions ROW into a runnable PipelineSpec (B1). A seeded row carries an
 * executable `spec` (JSON PipelineSpec) → parse it; a legacy NamedWorkflow row has a NULL spec →
 * LAZILY compile it into a single-orchestrator PipelineSpec (namedWorkflowToPipeline). Both paths
 * validate through PipelineSpecSchema so a malformed/legacy row fails loudly rather than half-runs.
 */
export function rowToPipelineSpec(row: Record<string, unknown>): PipelineSpec {
  const spec = row.spec
  if (spec != null) {
    let raw: unknown
    try { raw = JSON.parse(String(spec)) } catch { throw new Error(`rowToPipelineSpec: definition '${String(row.id)}' spec is not valid JSON`) }
    return PipelineSpecSchema.parse(raw)
  }
  // No executable spec → faithfully lift the legacy NamedWorkflow (one orchestrator stage).
  return namedWorkflowToPipeline(rowToNamedWorkflow(row))
}

/** Resolve a PipelineSpec from either a stored workflow definition id or a spec object
 *  passed directly. A stored definition resolves through rowToPipelineSpec (seeded spec OR a
 *  lazily-compiled legacy NamedWorkflow); a direct object validates through PipelineSpecSchema —
 *  so a malformed/legacy row fails loudly rather than half-runs. */
function resolveSpec(pipelineIdOrSpec: string | PipelineSpec): PipelineSpec {
  if (typeof pipelineIdOrSpec !== 'string') return PipelineSpecSchema.parse(pipelineIdOrSpec)
  const row = workflowDefsDb.getWorkflowDefRow.get(pipelineIdOrSpec) as Record<string, unknown> | undefined
  if (!row) throw new Error(`startPipelineRun: no workflow definition '${pipelineIdOrSpec}'`)
  return rowToPipelineSpec(row)
}

/**
 * The delegation seam. Resolve a PipelineSpec (by definition id or a direct spec object),
 * instantiate it, and return the new pipelineRunId. The scheduler's interval picks up the
 * running pipeline and dispatches its entry stage on the next tick (an immediate kick is a
 * C-later nicety — the relay/route callers tolerate the poll latency, exactly like the
 * lead-dispatch relay). FAIL-CLOSED on a non-git cwd (resolveHeadCommit throws).
 */
export async function startPipelineRun(
  pipelineIdOrSpec: string | PipelineSpec,
  opts: InstantiateOptions,
): Promise<{ pipelineRunId: string }> {
  const spec = resolveSpec(pipelineIdOrSpec)
  const definitionId = opts.definitionId ?? (typeof pipelineIdOrSpec === 'string' ? pipelineIdOrSpec : null)
  const pipelineRunId = instantiatePipeline(spec, { ...opts, definitionId })
  return { pipelineRunId }
}
