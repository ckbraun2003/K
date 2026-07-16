/**
 * PipelineEngine — the DAG advance (D-119 Lane A, wave A3).
 *
 * The engine turns a READY stage into work and reacts to its outcome. It never names a
 * worktree or spawns a process — that is the StageExecutor's job (pipeline-executor.ts);
 * the engine only computes the per-edge base commit (pipeline-handoff.ts), dispatches, and
 * writes status transitions. Every transition is a DB write, so a mid-pipeline reboot is
 * reconcilable (reconcilePipelines, wired at boot AFTER the stale-run sweep).
 *
 * Split of responsibility with the scheduler (pipeline-scheduler.ts):
 *   - the SCHEDULER decides WHICH pending stage is ready (listReadyStages), gates agent
 *     stages on budget + concurrency, CAS-claims (pending→dispatched), and calls
 *     dispatchStage; then calls maybeFinalizePipeline.
 *   - the ENGINE (here) computes the base, dispatches, and records the result; a supervised
 *     stage's completion rides trackSupervisedRun → onStageRunTerminal (minimal, idempotent,
 *     runs in a bus tick), with the actual DAG advance deferred to the next scheduler tick.
 *
 * A4 adds retry-IN-PLACE (handleStageFailure): a retryable stage failure re-dispatches the SAME
 * stage at its STORED base_commit (fixed fork point, NOT recomputed) — an agent stage on the
 * fallback model the shared retry brain picks, a deterministic stage re-running its command —
 * bounded by the StageDef's retry.maxAttempts + measured budget headroom, stamping the retry
 * run's runs.pipeline_stage_id + retry_of lineage. Repair-stage ROUTING and gate resolution are
 * still A5; an exhausted / non-retryable failure marks the stage failed and the pipeline
 * finalizes 'failed' once it quiesces.
 */

import { db, pipelineDb, runsDb } from './db.js'
import { RetryPolicySchema, type RetryPolicy } from '@k/shared'
import { resolveBaseCommit, mergeBranches, type PipelineEdgeRow } from './pipeline-handoff.js'
import { WorktreeStageExecutor, type StageExecutor, type StageContext, type StageDispatchResult, type PipelineStageRow } from './pipeline-executor.js'
import { trackSupervisedRun, isTerminalRunStatus } from './run-lifecycle.js'
import { listRunCheckpoints } from './checkpoints.js'
import { budgetGate } from './budget-governor.js'
import { classifyRunFailure, stampRetryLineage } from './self-heal.js'

/** A materialized `pipeline_runs` row (the DDL columns the engine reads; db.ts:705). */
export interface PipelineRunRow {
  id: string
  definition_id: string | null
  project_id: string | null
  title: string
  cwd: string
  base_commit: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  created_at: number
  updated_at: number
  completed_at: number | null
}

// The default execution substrate (the current git-worktree/process backend). Injectable
// per call so a stub executor (tests) or a future DockerStageExecutor slots in unchanged.
const defaultExecutor: StageExecutor = new WorktreeStageExecutor()

// The pipeline-ownership back-ref (§10 mandatory guard, consumed by A4's self-heal skip):
// stamped on runs at dispatch and NEVER overwritten, so every run the engine dispatches
// (originals + A4 retries) is recognized as pipeline-owned. Keyed here on runs.id — NOT on
// pipeline_stages.run_id (a retry overwrites that, orphaning the failed original). A local
// prepared statement (the backlog-relay precedent) keeps db.ts's W0 runsDb bundle frozen.
const stampRunPipelineStage = db.prepare(`UPDATE runs SET pipeline_stage_id = ? WHERE id = ?`)

// Record a stage's computed fork base at dispatch (for observability + reconcile), for EVERY
// kind — the supervised path's setStageRun re-writes the same value, but a settled
// deterministic/hook stage would otherwise leave base_commit NULL. Local prepared statement
// (the backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen.
const stampStageBase = db.prepare(`UPDATE pipeline_stages SET base_commit = @baseCommit, updated_at = @updatedAt WHERE id = @id`)

// Increment a stage's retry_count on a retry-in-place (A4). Local prepared statement (the
// backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen.
const bumpStageRetryCount = db.prepare(`UPDATE pipeline_stages SET retry_count = @retryCount, updated_at = @updatedAt WHERE id = @id`)

const STAGE_TERMINAL = new Set(['passed', 'failed', 'skipped'])

/** A stage's frozen retry policy (StageDef.retry). A malformed / absent spec → the schema
 *  defaults (maxAttempts 1 = no retry), so a bad spec fails CLOSED rather than retry-storming. */
function parseRetryPolicy(spec: string): RetryPolicy {
  try {
    return RetryPolicySchema.parse((JSON.parse(spec) as { retry?: unknown }).retry ?? {})
  } catch {
    return RetryPolicySchema.parse({})
  }
}

/**
 * Dispatch a single READY, already-CLAIMED (status='dispatched') stage: compute its base
 * commit from the incoming edges, dispatch it via the executor, and record the outcome.
 * A merge base that conflicts hard-fails the stage (A4 will route repair; A3 fails the
 * pipeline once it quiesces). Never re-claims — the scheduler owns the claim CAS.
 */
export async function dispatchStage(
  run: PipelineRunRow,
  stage: PipelineStageRow,
  executor: StageExecutor = defaultExecutor,
): Promise<void> {
  // Compute the fork base from the incoming edges + the upstream stages' result_commits.
  const incoming = pipelineDb.listIncomingEdges.all({ pipelineRunId: run.id, toStageKey: stage.stage_key }) as PipelineEdgeRow[]
  const byKey = new Map((pipelineDb.listStagesForPipeline.all(run.id) as PipelineStageRow[]).map(s => [s.stage_key, s]))
  const resolution = resolveBaseCommit(incoming, byKey, run.base_commit)

  let base: string
  if ('merge' in resolution) {
    const merged = await mergeBranches(run.base_commit, resolution.merge, run.cwd)
    if ('conflict' in merged) {
      // NEVER auto-resolve. A4 routes repair on a merge conflict; A3 records the failure and
      // the pipeline finalizes 'failed' once it quiesces.
      markStageFailed(stage.id, 'merge_conflict', null)
      return
    }
    base = merged.mergedSha
  } else {
    base = resolution.base
  }
  stampStageBase.run({ id: stage.id, baseCommit: base, updatedAt: Date.now() })
  stage.base_commit = base // keep the in-memory row in sync for recordDispatchResult / a retry

  const ctx: StageContext = {
    pipelineRunId: run.id,
    stage,
    projectId: run.project_id,
    cwd: run.cwd,
    baseCommit: base,
  }
  const result = await executor.dispatch(ctx)
  await recordDispatchResult(run, stage, result, {}, executor)
}

/**
 * Persist a dispatch outcome onto its stage — the shared body both the initial dispatchStage
 * and a retry re-dispatch (handleStageFailure) funnel through. On a RETRY the caller passes
 * {isRetry, originalRunId} so a supervised retry ALSO stamps retry_of/retry_count lineage on
 * the new run. Every supervised dispatch (original OR retry) stamps runs.pipeline_stage_id —
 * the §10 ownership back-ref that keeps the failed original recognized as pipeline-owned.
 */
async function recordDispatchResult(
  run: PipelineRunRow,
  stage: PipelineStageRow,
  result: StageDispatchResult,
  opts: { isRetry?: boolean; originalRunId?: string } = {},
  executor: StageExecutor = defaultExecutor,
): Promise<void> {
  const base = stage.base_commit
  switch (result.kind) {
    case 'supervised': {
      // Stamp the ownership back-ref on the RUN (keyed on runs.id — never overwritten by a later
      // retry) BEFORE tracking, then wire the run + its base and flip dispatched→running (run_id
      // written synchronously so a reboot can reconcile the claim window — §10).
      stampRunPipelineStage.run(stage.id, result.runId)
      pipelineDb.setStageRun.run({ id: stage.id, runId: result.runId, baseCommit: base, updatedAt: Date.now() })
      // A retry links the new run to the failed original (retry_of/retry_count) + broadcasts
      // run_retried, so the retry-rate metric + live DAG see the descend.
      if (opts.isRetry && opts.originalRunId) stampRetryLineage(result.runId, opts.originalRunId, stage.retry_count)
      // React to the supervised run's terminal. onStarted is a no-op (the run_id is already
      // wired above); finalize is minimal + deferred (DAG advance happens next scheduler tick),
      // and a non-'done' terminal drives the A4 retry ladder.
      trackSupervisedRun(result.runId, { onStarted: () => {}, finalize: status => onStageRunTerminal(stage.id, status) })
      break
    }
    case 'settled': {
      if (result.status === 'passed') {
        markStagePassed(stage.id, result.resultCommit ?? base ?? null, result.exitCode ?? 0)
      } else {
        // A deterministic / hook-script failure routes through the retry brain (re-run the same
        // command, bounded by retry.maxAttempts); exhausted / non-retryable → markStageFailed.
        await handleStageFailure(run, stage, { settled: true, exitCode: result.exitCode ?? null }, executor)
      }
      break
    }
    case 'parked': {
      pipelineDb.markStageAwaitingGate.run({ id: stage.id, updatedAt: Date.now() })
      break
    }
  }
}

/**
 * A stage FAILED — retry it IN PLACE (A4) when the failure is retryable, the StageDef's
 * retry.maxAttempts budget still has headroom, and the measured budget allows; else mark it
 * failed. The retry re-dispatches the SAME stage at its STORED base_commit (the fork point is
 * fixed — NOT recomputed): a supervised (agent) failure re-runs on the fallback model the
 * shared retry brain (classifyRunFailure) picks; a deterministic / hook-script failure re-runs
 * its command unchanged (retryable iff the policy opts into any class). Repair-stage ROUTING
 * is A5.
 *
 * maxAttempts is TOTAL attempts (the original + its retries); the schema default of 1 means NO
 * retry. A retry is permitted only while the attempts already made (retry_count + 1) stay below
 * that max — so the default policy never silently retries.
 *
 * Called fire-and-forget from onStageRunTerminal (a supervised terminal rides a bus tick): the
 * re-dispatch is fast (startAgentRun returns quickly) and the retry run's own terminal rides
 * trackSupervisedRun again, so the ladder climbs naturally.
 */
export async function handleStageFailure(
  run: PipelineRunRow,
  stage: PipelineStageRow,
  failure: { supervised: true } | { settled: true; exitCode: number | null },
  executor: StageExecutor = defaultExecutor,
): Promise<void> {
  // Re-read for the current retry_count (a prior retry may have bumped it) + idempotency.
  const fresh = pipelineDb.getStage.get(stage.id) as PipelineStageRow | undefined
  if (!fresh || STAGE_TERMINAL.has(fresh.status)) return

  const policy = parseRetryPolicy(fresh.spec)

  // Derive retryability + the retry's model override + the class/exit code to record on a fail.
  let retryable: boolean
  let modelOverride: string | undefined
  let failureClass: string | null
  let exitCode: number | null = null
  if ('supervised' in failure) {
    // The failed run's classification drives retryability + the fallback model (the SAME brain
    // the global self-heal uses — pipeline runs are skipped THERE via the ownership guard).
    const failedRun = fresh.run_id
      ? (runsDb.getRun.get(fresh.run_id) as { id: string; status: string; model?: string | null } | undefined)
      : undefined
    if (failedRun) {
      const d = classifyRunFailure(failedRun)
      retryable = d.retryable && d.fallbackModel != null
      modelOverride = d.fallbackModel ?? undefined
      failureClass = d.cls
    } else {
      retryable = false
      failureClass = null
    }
  } else {
    // A deterministic / hook-script failure: re-run the SAME command (no model change). Retryable
    // iff the policy opts into any class (an exit-code failure is treated as ~'transient').
    retryable = policy.retryOn.length > 0
    failureClass = 'transient'
    exitCode = failure.exitCode
  }

  const attemptsMade = fresh.retry_count + 1
  if (attemptsMade < policy.maxAttempts && retryable && budgetGate({ projectId: run.project_id }).allowed) {
    const originalRunId = fresh.run_id ?? undefined
    bumpStageRetryCount.run({ id: fresh.id, retryCount: attemptsMade, updatedAt: Date.now() })
    fresh.retry_count = attemptsMade // keep in-memory in sync for the lineage stamp below
    // Re-dispatch the SAME stage at its STORED base_commit (fixed fork point) — the fallback
    // model for an agent stage, undefined for a deterministic one (ignored there anyway).
    const ctx: StageContext = {
      pipelineRunId: run.id, stage: fresh, projectId: run.project_id, cwd: run.cwd,
      baseCommit: fresh.base_commit, modelOverride,
    }
    const result = await executor.dispatch(ctx)
    await recordDispatchResult(run, fresh, result, { isRetry: true, originalRunId }, executor)
    return
  }
  markStageFailed(fresh.id, failureClass, exitCode)
}

/**
 * A supervised stage's run reached a terminal status — MINIMAL + idempotent (runs inside a
 * trackSupervisedRun bus tick). A 'done' terminal maps to the stage's pass + handoff commit; a
 * non-'done' terminal drives the A4 retry ladder (else markStageFailed). The DAG advance
 * (dispatch newly-ready stages, finalize) is deferred to the next scheduler tick.
 */
export function onStageRunTerminal(stageId: string, runStatus: string): void {
  const stage = pipelineDb.getStage.get(stageId) as PipelineStageRow | undefined
  if (!stage || STAGE_TERMINAL.has(stage.status)) return // idempotent — already retired
  if (runStatus === 'done') {
    // The handoff is the run's terminal checkpoint SHA (last of the durable chain), else the
    // stage's fork base when the run committed no checkpoint.
    const cps = stage.run_id ? listRunCheckpoints(stage.run_id) : []
    const resultCommit = cps.length ? cps[cps.length - 1].sha : (stage.base_commit ?? undefined)
    markStagePassed(stageId, resultCommit ?? null, 0)
    return
  }
  // A non-'done' terminal → A4 retry-in-place (fallback model, same base), else markStageFailed.
  // Fetch the owning pipeline run for the retry's budget/cwd/project scope. Fire-and-forget: the
  // re-dispatch is fast and the retry run's own terminal rides trackSupervisedRun again, so the
  // ladder climbs without blocking this bus tick.
  const run = pipelineDb.getPipelineRun.get(stage.pipeline_run_id) as PipelineRunRow | undefined
  if (!run) { markStageFailed(stageId, null, null); return }
  void handleStageFailure(run, stage, { supervised: true }).catch(err => {
    console.warn(`[pipeline-engine] stage ${stageId} failure handling threw:`, err)
  })
}

/**
 * Finalize a pipeline once it QUIESCES — no stage in-flight (dispatched/running), no gate
 * parked (A5 resolves those, so a parked gate keeps the pipeline 'running'), and nothing
 * ready to dispatch. A quiesced pipeline with any failed OR any stranded-pending stage (a
 * downstream whose predecessor failed, so it can never become ready — A3 has no repair) is
 * 'failed'; otherwise 'completed'. Idempotent — only a 'running' pipeline is transitioned.
 */
export function maybeFinalizePipeline(pipelineRunId: string): void {
  const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow | undefined
  if (!run || run.status !== 'running') return
  const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
  if (stages.length === 0) return

  const inFlight = stages.some(s => s.status === 'dispatched' || s.status === 'running')
  const awaitingGate = stages.some(s => s.status === 'awaiting_gate')
  if (inFlight || awaitingGate) return
  if ((pipelineDb.listReadyStages.all({ pid: pipelineRunId }) as PipelineStageRow[]).length > 0) return

  // Quiesced: no more progress is possible on this tick's DAG.
  const anyFailed = stages.some(s => s.status === 'failed')
  const anyStranded = stages.some(s => s.status === 'pending') // unreachable now (upstream failed)
  const now = Date.now()
  pipelineDb.updatePipelineStatus.run({
    id: pipelineRunId,
    status: anyFailed || anyStranded ? 'failed' : 'completed',
    updatedAt: now,
    completedAt: now,
  })
}

/**
 * Boot reconciliation for RUNNING pipelines (wired into the boot sweep AFTER reconcileStaleRuns
 * has flipped crashed runs terminal). For each running pipeline:
 *   - a running/dispatched stage whose linked run is terminal → DERIVE (done → passed with its
 *     terminal checkpoint; any other terminal → failed);
 *   - a 'dispatched' stage with a NULL run_id (the claim window crashed before setStageRun) →
 *     mark FAILED, never re-pending (re-pending would double-execute — the lead-relay policy);
 *   - 'awaiting_gate' survives (A5 resolves it); passed/failed/skipped/pending untouched;
 *   - finalize any pipeline that has quiesced.
 */
export function reconcilePipelines(): void {
  const running = pipelineDb.listRunningPipelines.all() as PipelineRunRow[]
  for (const run of running) {
    const stages = pipelineDb.listStagesForPipeline.all(run.id) as PipelineStageRow[]
    for (const stage of stages) {
      if (stage.status !== 'running' && stage.status !== 'dispatched') continue
      if (stage.run_id) {
        const r = runsDb.getRun.get(stage.run_id) as { status?: string } | undefined
        if (r && isTerminalRunStatus(r.status)) {
          if (r.status === 'done') {
            const cps = listRunCheckpoints(stage.run_id)
            markStagePassed(stage.id, cps.length ? cps[cps.length - 1].sha : (stage.base_commit ?? null), 0)
          } else {
            markStageFailed(stage.id, null, null)
          }
        }
        // else: the run is still non-terminal (should not happen post stale-run sweep) — leave it.
      } else {
        // dispatched with no run_id: the claim window crashed. Fail it (never re-pending).
        markStageFailed(stage.id, null, null)
      }
    }
    maybeFinalizePipeline(run.id)
  }
}

// ── status writers (one place to keep the completed_at/updated_at bookkeeping) ──────────

function markStagePassed(stageId: string, resultCommit: string | null, exitCode: number | null): void {
  const now = Date.now()
  pipelineDb.markStagePassed.run({ id: stageId, resultCommit, exitCode, costUsd: null, updatedAt: now, completedAt: now })
}

function markStageFailed(stageId: string, failureClass: string | null, exitCode: number | null): void {
  const now = Date.now()
  pipelineDb.markStageFailed.run({ id: stageId, failureClass, exitCode, costUsd: null, updatedAt: now, completedAt: now })
}
