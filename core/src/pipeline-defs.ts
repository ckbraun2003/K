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
import { db, pipelineDb, workflowDefsDb, rowToNamedWorkflow } from './db.js'

// Stamp a loop edge's maxIterations onto its row (orch-p2 A.2). The W0 pipelineDb.insertEdge
// bundle stays frozen (it predates the loop cap), so — following the engine's local-prepared-
// statement precedent — a bounded-loop edge's cap is written here right after the base insert.
const stampEdgeMaxIterations = db.prepare(`UPDATE pipeline_edges SET max_iterations = @maxIterations WHERE id = @id`)

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
  /** C1 (delegate_pipeline `model`): a pipeline-wide model override applied to every agent /
   *  hook-agent stage that pins NO model of its own, so an operator can run a whole pipeline on a
   *  chosen model. It rides the SAME StageDef.model → executor seam a per-stage model uses (no
   *  executor/engine change). A stage with an explicit model keeps it; a non-agent stage is
   *  unaffected. Absent → each stage's own model governs — byte-identical to today. */
  model?: string | null
}

/** Apply a pipeline-wide model override onto an agent / hook-agent stage that pins no model of
 *  its own (C1). A stage that already names a model, or any non-agent stage, is returned
 *  unchanged. Returns a shallow-cloned StageDef so the resolved spec object is never mutated in
 *  place; `model == null` is a no-op passthrough so a modelless dispatch is byte-identical. */
function applyModelOverride(stage: StageDef, model: string | null | undefined): StageDef {
  if (model == null) return stage
  if (stage.kind === 'agent' && stage.model == null) return { ...stage, model }
  if (stage.kind === 'hook' && stage.hook.type === 'agent' && stage.hook.model == null) {
    return { ...stage, hook: { ...stage.hook, model } }
  }
  return stage
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
    // A pipeline-wide model override (C1) is baked into each modelless agent/hook-agent stage's
    // stored spec here, so the executor picks it up per-stage via its existing StageDef.model read.
    const staged = applyModelOverride(stage, opts.model)
    pipelineDb.insertStage.run({
      id: randomUUID(),
      pipelineRunId,
      stageKey: staged.id,
      kind: staged.kind,
      profileId: stageProfileId(staged),
      spec: JSON.stringify(staged),
      baseCommit: null, // computed per-edge at dispatch (pipeline-handoff.ts)
      repairStageKey: staged.repair?.toStage ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  for (const edge of spec.edges) {
    const edgeId = randomUUID()
    pipelineDb.insertEdge.run({
      id: edgeId,
      pipelineRunId,
      fromStageKey: edge.from,
      toStageKey: edge.to,
      handoff: edge.handoff,
      whenCond: edge.when,
    })
    // A bounded-loop back-edge carries its hard iteration cap (the schema guarantees
    // maxIterations is present when when==='loop'); the engine reads it off the row.
    if (edge.when === 'loop' && edge.maxIterations != null) {
      stampEdgeMaxIterations.run({ id: edgeId, maxIterations: edge.maxIterations })
    }
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
