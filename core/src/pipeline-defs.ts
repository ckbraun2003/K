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
import { PipelineSpecSchema, type PipelineSpec, type StageDef } from '@k/shared'
import { pipelineDb } from './db.js'

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

/** Resolve a PipelineSpec from either a stored workflow definition id or a spec object
 *  passed directly. A stored spec is JSON in workflow_definitions.spec; both paths validate
 *  through PipelineSpecSchema so a malformed/legacy row fails loudly rather than half-runs. */
function resolveSpec(pipelineIdOrSpec: string | PipelineSpec): PipelineSpec {
  if (typeof pipelineIdOrSpec !== 'string') return PipelineSpecSchema.parse(pipelineIdOrSpec)
  const row = pipelineDb.getDefSpec.get(pipelineIdOrSpec) as { spec?: string | null } | undefined
  if (!row) throw new Error(`startPipelineRun: no workflow definition '${pipelineIdOrSpec}'`)
  if (row.spec == null) {
    // Lazy compilation of a legacy NamedWorkflow → PipelineSpec lands in Lane B (B1).
    throw new Error(`startPipelineRun: definition '${pipelineIdOrSpec}' has no executable spec yet`)
  }
  let raw: unknown
  try { raw = JSON.parse(row.spec) } catch { throw new Error(`startPipelineRun: definition '${pipelineIdOrSpec}' spec is not valid JSON`) }
  return PipelineSpecSchema.parse(raw)
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
