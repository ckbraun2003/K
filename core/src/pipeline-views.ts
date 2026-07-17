/**
 * pipeline-views.ts — the DB-rows → wire-view projection + the `pipeline_update` WS
 * broadcast (D-119 Lane C, wave C2).
 *
 * WHY THIS LAYER (kept OUT of the engine writers)
 * -----------------------------------------------
 * The engine (pipeline-engine.ts) only WRITES status transitions; it never assembles a wire
 * view or touches the WS. This module is the read/projection seam the API + the scheduler +
 * the boot terminal-listener share, so the engine stays uncoupled from the wire (§7): the
 * scheduler broadcasts once per pass that changed anything, a boot listener broadcasts on
 * pipeline finalize (onPipelineTerminal), and the gate/rewind/cancel routes broadcast after
 * their mutation. Every broadcast is TRANSIENT (not persisted) — the durable facts live in
 * pipeline_runs/pipeline_stages/pipeline_edges; the WS delta just nudges the live DAG.
 *
 * `getPipelineRunView` maps the three ledger tables to the W0 `PipelineRunViewSchema` and
 * VALIDATES against it before returning, so a malformed row fails loudly rather than shipping
 * a broken view onto the wire. Per-stage cost is the LINKED run's measured `runs.cost_usd`
 * (falling back to the stage's own recorded cost); a stage's `attempt`/`maxAttempts` come from
 * its retry_count + the frozen StageDef retry policy.
 */

import { db, pipelineDb, runsDb } from './db.js'
import { eventBus } from './events.js'
import {
  PipelineRunSchema,
  PipelineRunViewSchema,
  FailureClassSchema,
  RetryPolicySchema,
  canonicalizePipelineStageStatus,
  type PipelineRun,
  type PipelineRunView,
  type FailureClass,
  type PipelineStageStatus,
} from '@k/shared'
import { onPipelineTerminal } from './pipeline-engine.js'
import type { PipelineRunRow } from './pipeline-engine.js'
import type { PipelineStageRow } from './pipeline-executor.js'
import type { PipelineEdgeRow } from './pipeline-handoff.js'

// Recent pipeline runs (bounded), newest first — the run-picker's identity source (mirrors
// workflowRunsDb.listRecentWorkflowRuns). Local prepared statement (the backlog-relay
// precedent) so db.ts's W0 pipelineDb bundle stays frozen.
const selectRecentPipelineRuns = db.prepare(`SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT ?`)

/** The most recent pipeline_runs rows (bounded), newest first. */
export function listRecentPipelineRuns(limit: number): PipelineRunRow[] {
  return selectRecentPipelineRuns.all(limit) as PipelineRunRow[]
}

/** A stage's TOTAL-attempts budget from its frozen StageDef retry policy. A malformed / absent
 *  spec → the schema default (1 = no retry), mirroring pipeline-engine.parseRetryPolicy. */
function maxAttemptsFor(spec: string): number {
  try {
    return RetryPolicySchema.parse((JSON.parse(spec) as { retry?: unknown }).retry ?? {}).maxAttempts
  } catch {
    return 1
  }
}

/** A stage's measured cost: the LINKED run's finalized runs.cost_usd when a run is wired (the
 *  originals + retries share the stage's current run_id), else the stage's own recorded cost.
 *  Null when neither is known. */
function stageCost(s: PipelineStageRow): number | null {
  if (s.run_id) {
    const r = runsDb.getRun.get(s.run_id) as { cost_usd?: number | null } | undefined
    if (r && r.cost_usd != null) return r.cost_usd
  }
  return s.cost_usd ?? null
}

/** Coerce a stored failure_class onto the wire FailureClass enum. The engine writes some
 *  non-enum sentinels (e.g. 'merge_conflict'); map any unrecognized non-null value to
 *  'unknown' so the wire schema always validates, and keep a genuine NULL as null. */
function coerceFailureClass(raw: string | null): FailureClass | null {
  if (raw == null) return null
  const parsed = FailureClassSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'unknown'
}

/** Project a pipeline_runs row onto the wire PipelineRun shape (validated). */
export function pipelineRunRowToWire(r: PipelineRunRow): PipelineRun {
  return PipelineRunSchema.parse({
    id: r.id,
    definitionId: r.definition_id,
    projectId: r.project_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    ownerProfileId: r.owner_profile_id,
  })
}

/**
 * Assemble the full live view of a pipeline run: the run + every stage (with its canonical
 * triple, attempt/repairs, measured cost, gate note, handoff commits) + the materialized DAG
 * edges. Returns null for an unknown pipeline. VALIDATES against PipelineRunViewSchema before
 * returning so a corrupt row surfaces here rather than on the wire.
 */
export function getPipelineRunView(pipelineRunId: string): PipelineRunView | null {
  const runRow = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow | undefined
  if (!runRow) return null

  const stageRows = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
  const edgeRows = pipelineDb.listEdges.all(pipelineRunId) as PipelineEdgeRow[]

  const stages = stageRows.map(s => {
    const status = s.status as PipelineStageStatus
    return {
      id: s.id,
      pipelineRunId: s.pipeline_run_id,
      stageKey: s.stage_key,
      kind: s.kind,
      status,
      canonical: canonicalizePipelineStageStatus(status),
      runId: s.run_id,
      attempt: s.retry_count + 1, // 1-based: the current attempt number (retry_count = retries so far)
      maxAttempts: maxAttemptsFor(s.spec),
      repairs: s.repairs_used,
      costUsd: stageCost(s),
      failureClass: coerceFailureClass(s.failure_class),
      gateNote: s.gate_note,
      baseCommit: s.base_commit,
      resultCommit: s.result_commit,
      startedAt: s.started_at,
      completedAt: s.completed_at,
    }
  })

  const edges = edgeRows.map(e => ({
    from: e.from_stage_key,
    to: e.to_stage_key,
    handoff: e.handoff,
    when: e.when_cond,
  }))

  return PipelineRunViewSchema.parse({ run: pipelineRunRowToWire(runRow), stages, edges })
}

/**
 * Broadcast a `pipeline_update` WS delta carrying the refreshed run view so the live DAG
 * re-renders. `stageId` names the transitioned stage (null for run-level transitions:
 * creation / finalize / cancel). A no-op if the pipeline vanished between the transition and
 * this call (getPipelineRunView returns null). TRANSIENT — never persisted.
 */
export function broadcastPipelineUpdate(pipelineRunId: string, stageId: string | null = null): void {
  const view = getPipelineRunView(pipelineRunId)
  if (!view) return
  eventBus.broadcast({ type: 'pipeline_update', pipelineRunId, stageId, view })
}

/**
 * Boot wiring: broadcast a `pipeline_update` every time a pipeline reaches a terminal status
 * (completed | failed) via the engine's onPipelineTerminal seam — so the finalize is live on
 * the wire without coupling maybeFinalizePipeline to the WS. Returns the unregister teardown
 * (wired next to the other pipeline schedulers in index.ts). Mirrors startBudgetBroadcast.
 */
export function startPipelineUpdateBroadcast(): () => void {
  return onPipelineTerminal(pipelineRunId => broadcastPipelineUpdate(pipelineRunId, null))
}
