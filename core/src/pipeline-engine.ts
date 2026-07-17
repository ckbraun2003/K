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

import { randomUUID, createHash } from 'crypto'
import { db, pipelineDb, runsDb } from './db.js'
import { RetryPolicySchema, StageDefSchema, type RetryPolicy } from '@k/shared'
import { resolveBaseCommit, mergeBranches, type PipelineEdgeRow } from './pipeline-handoff.js'
import { WorktreeStageExecutor, type StageExecutor, type StageContext, type StageDispatchResult, type PipelineStageRow } from './pipeline-executor.js'
import { trackSupervisedRun, isTerminalRunStatus } from './run-lifecycle.js'
import { listRunCheckpoints } from './checkpoints.js'
import { budgetGate } from './budget-governor.js'
import { classifyRunFailure, stampRetryLineage } from './self-heal.js'
import { appendLedger } from './pipeline-ledger.js'

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
  // orch-p2 C.3: nullable orchestrator-ownership back-ref (db.ts:1762 migration);
  // no dispatch path stamps it yet — surfaced null-safe through to the wire.
  owner_profile_id: string | null
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

// Dead-branch a pending stage whose activation is now impossible (A5 markSkips). CAS-guarded on
// status='pending' so it never clobbers an in-flight / already-terminal stage. Local prepared
// statement (the backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen.
const markStageSkipped = db.prepare(`UPDATE pipeline_stages SET status = 'skipped', updated_at = @updatedAt WHERE id = @id AND status = 'pending'`)

// Rewind-to-stage (C2 operator retry): reset a stage to a clean 'pending' slate — drop the linked
// run + its handoff/exit/failure columns + started_at/completed_at. Applied to the target AND its
// transitive downstream closure. Local prepared statement (the backlog-relay precedent) so db.ts's
// W0 pipelineDb bundle stays frozen.
const rewindResetStage = db.prepare(`UPDATE pipeline_stages SET status = 'pending', run_id = NULL, result_commit = NULL, exit_code = NULL, failure_class = NULL, started_at = NULL, completed_at = NULL, updated_at = @updatedAt WHERE id = @id`)
// The rewind TARGET additionally resets retry_count so a manual retry starts a fresh ladder
// (downstream stages keep theirs — they were pending/skipped, i.e. already 0).
const rewindResetTargetRetry = db.prepare(`UPDATE pipeline_stages SET retry_count = 0, updated_at = @updatedAt WHERE id = @id`)

// orch-p2 A.2 — bounded loop re-entry. `bumpStageIteration` advances a loop HEAD's re-entry
// counter; `resetStageForLoop` returns a loop BODY stage to a clean 'pending' slate for its next
// pass (drops run/handoff/exit columns AND resets retry_count so each iteration gets its full
// retry budget) — mirrors rewindResetStage but iteration-bounded. Local prepared statements (the
// backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen.
// review I-1 (belt-and-suspenders): the reset is CAS-guarded to never touch a 'running'/'dispatched'
// stage — a loop re-entry that raced an in-flight body sibling would otherwise NULL its run_id mid-
// flight (orphaned run + double-execution). maybeFinalizePipeline already defers re-entry until the
// pipeline quiesces (so this never fires on an in-flight stage in practice), but the guard makes the
// invariant explicit at the SQL layer.
const bumpStageIteration = db.prepare(`UPDATE pipeline_stages SET iteration = @iteration, updated_at = @updatedAt WHERE id = @id`)
const resetStageForLoop = db.prepare(`UPDATE pipeline_stages SET status = 'pending', run_id = NULL, result_commit = NULL, exit_code = NULL, failure_class = NULL, retry_count = 0, started_at = NULL, completed_at = NULL, updated_at = @updatedAt WHERE id = @id AND status NOT IN ('running','dispatched')`)

const STAGE_TERMINAL = new Set(['passed', 'failed', 'skipped'])

// ── pipeline terminal callback (C1) ─────────────────────────────────────────────
//
// A pipeline is MULTI-run (many supervised stage runs), so there is no single
// trackSupervisedRun terminal to ride the way a lead/Chief report-back does. This
// engine-level callback is the terminal seam instead: maybeFinalizePipeline fires it
// exactly once — right after it transitions a pipeline to completed/failed — and the K
// report-back (k-thread.ts::continuePipelineOutcomeToK) is the sole production listener,
// joining a K-delegated pipeline's outcome back onto its durable thread.

type PipelineTerminalListener = (pipelineRunId: string, status: 'completed' | 'failed') => void
const pipelineTerminalListeners = new Set<PipelineTerminalListener>()

/** Register a listener invoked once each time a pipeline reaches a terminal status
 *  (completed | failed) via maybeFinalizePipeline. Returns an unregister fn (mirrors the
 *  EventBus subscribe shape) so a boot wiring can be torn down / a test can clean up. */
export function onPipelineTerminal(listener: PipelineTerminalListener): () => void {
  pipelineTerminalListeners.add(listener)
  return () => pipelineTerminalListeners.delete(listener)
}

/** Fan a terminal transition out to every registered listener. Each is isolated so a throwing
 *  listener can never propagate into (and abort) the finalize that emitted it. */
function emitPipelineTerminal(pipelineRunId: string, status: 'completed' | 'failed'): void {
  for (const listener of pipelineTerminalListeners) {
    try {
      listener(pipelineRunId, status)
    } catch (err) {
      console.warn(`[pipeline-engine] terminal listener threw for ${pipelineRunId}:`, err)
    }
  }
}

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
  // A.3 ledger: the engine picked this stage up for execution this tick.
  appendLedger(run.id, {
    stageKey: stage.stage_key, kind: 'transition', actor: stageActor(stage),
    goal: `${stage.stage_key} dispatched`, detail: { event: 'dispatch', kind: stage.kind },
  })
  // Compute the fork base from the incoming edges + the upstream stages' result_commits. A
  // `when:'loop'` back-edge is EXCLUDED (orch-p2 A.2): it is a pure control-flow trigger, never a
  // data-handoff source, so a re-opened loop head re-forks from its FORWARD incoming edge(s)
  // (the pre-loop stages' results) — never ambiguously from the loop source's tree.
  const incoming = (pipelineDb.listIncomingEdges.all({ pipelineRunId: run.id, toStageKey: stage.stage_key }) as PipelineEdgeRow[])
    .filter(e => e.when_cond !== 'loop')
  const byKey = new Map((pipelineDb.listStagesForPipeline.all(run.id) as PipelineStageRow[]).map(s => [s.stage_key, s]))
  const resolution = resolveBaseCommit(incoming, byKey, run.base_commit)

  let base: string
  if ('merge' in resolution) {
    const merged = await mergeBranches(run.base_commit, resolution.merge, run.cwd, `${run.id}/${stage.stage_key}-mergebase`)
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
      appendLedger(run.id, {
        stageKey: stage.stage_key, kind: 'gate', actor: stageActor(stage),
        goal: `${stage.stage_key} awaiting approval`, detail: { event: 'park' },
      })
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
    appendLedger(run.id, {
      stageKey: fresh.stage_key, kind: 'transition', actor: stageActor(fresh),
      goal: `${fresh.stage_key} retry ${attemptsMade}`, detail: { event: 'retry', attempt: attemptsMade, failureClass },
    })
    // Re-dispatch the SAME stage at its STORED base_commit (fixed fork point) — the fallback
    // model for an agent stage, undefined for a deterministic one (ignored there anyway).
    const ctx: StageContext = {
      pipelineRunId: run.id, stage: fresh, projectId: run.project_id, cwd: run.cwd,
      baseCommit: fresh.base_commit, modelOverride,
    }
    try {
      const result = await executor.dispatch(ctx)
      await recordDispatchResult(run, fresh, result, { isRetry: true, originalRunId }, executor)
    } catch (err) {
      // A retry re-dispatch throw (e.g. startAgentRun fails AFTER the budget gate) must never leave
      // the stage stuck 'running': the scheduler's try/catch guards only the INITIAL dispatch, but
      // this path is reached fire-and-forget from onStageRunTerminal's bus tick. Settle it failed.
      console.warn(`[pipeline-engine] stage ${fresh.id} retry re-dispatch failed:`, err)
      markStageFailed(fresh.id, failureClass, exitCode)
    }
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
 * Skip-propagation (A5) — flip every `pending` stage whose activation is now IMPOSSIBLE to
 * 'skipped', to a fixpoint (a newly-skipped stage can dead-en its own successors). Runs each
 * scheduler tick BEFORE readiness/dispatch, and inside maybeFinalizePipeline so a caller that
 * did not pre-run it (reconcilePipelines) still finalizes correctly.
 *
 * A pending stage S with ≥1 real incoming edge is DEAD (→ skipped) iff, letting P = its incoming
 * edges with when IN ('always','pass') and F = its incoming edges with when IN ('fail','repair'):
 *   • P non-empty AND some e∈P has a terminal-and-NOT-passed source (failed|skipped) — an
 *     AND-join predecessor can never all-pass; OR
 *   • P empty AND F non-empty AND EVERY e∈F has a terminal-and-NOT-failed source (passed|skipped)
 *     — a fail-only stage whose fail branches were all NOT taken can never fail-activate.
 * An entry stage (no real incoming edge) is never skipped. `awaiting_gate` is NOT terminal, so a
 * stage below an unresolved gate stays pending until the gate resolves.
 */
export function markSkips(pipelineRunId: string): void {
  const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
  const edges = pipelineDb.listEdges.all(pipelineRunId) as PipelineEdgeRow[]
  const statusByKey = new Map(stages.map(s => [s.stage_key, s.status]))
  const incomingByKey = new Map<string, PipelineEdgeRow[]>()
  for (const e of edges) {
    if (e.from_stage_key == null) continue // an entry edge has no source
    if (e.when_cond === 'loop') continue // a loop back-edge never forecloses a stage's activation (A.2)
    const list = incomingByKey.get(e.to_stage_key) ?? []
    list.push(e)
    incomingByKey.set(e.to_stage_key, list)
  }

  const terminalNotPassed = (e: PipelineEdgeRow): boolean => {
    const st = statusByKey.get(e.from_stage_key!)
    return st === 'failed' || st === 'skipped'
  }
  const terminalNotFailed = (e: PipelineEdgeRow): boolean => {
    const st = statusByKey.get(e.from_stage_key!)
    return st === 'passed' || st === 'skipped'
  }

  let changed = true
  while (changed) {
    changed = false
    for (const s of stages) {
      if (statusByKey.get(s.stage_key) !== 'pending') continue
      const incoming = incomingByKey.get(s.stage_key) ?? []
      if (incoming.length === 0) continue // entry — never skipped
      const P = incoming.filter(e => e.when_cond === 'always' || e.when_cond === 'pass')
      const F = incoming.filter(e => e.when_cond === 'fail') // 'repair' never activates readiness (deferred)
      // Dead only when BOTH activation paths are foreclosed — mirrors listReadyStages' OR semantics
      // (AND-join OR fail-activation). Skipping on pass-dead alone over-skipped a mixed pass+fail
      // stage the readiness query would have fail-activated (SEAMS F3). An all-empty incoming set is
      // unreachable here (the `incoming.length === 0` entry guard above already `continue`d).
      const passDead = P.length === 0 || P.some(terminalNotPassed)
      const failDead = F.length === 0 || F.every(terminalNotFailed)
      const dead = passDead && failDead
      if (dead) {
        markStageSkipped.run({ id: s.id, updatedAt: Date.now() })
        statusByKey.set(s.stage_key, 'skipped') // fixpoint — this may dead-en successors next pass
        changed = true
      }
    }
  }
}

/**
 * Finalize a pipeline once it QUIESCES — SKIP-AWARE (A5). markSkips runs first (dead-branching
 * untaken/unreachable pending stages), then: quiesced = no stage dispatched/running/awaiting_gate
 * AND nothing ready to dispatch (a parked gate keeps the pipeline 'running' — A5 resolves it). A
 * quiesced pipeline is 'failed' iff a `failed` stage has NO out-edge when IN ('fail','repair') —
 * an UNHANDLED dead-end failure — OR a `pending` stage remains (a guard; markSkips should have
 * cleared it). `skipped` is NEUTRAL. This replaces the A3 any-stranded-pending heuristic that
 * mis-failed a successful pipeline whose untaken gate/fail branch was left 'pending'. Idempotent —
 * only a 'running' pipeline is transitioned.
 */
/**
 * Bounded-loop re-entry (orch-p2 A.2) — the crux that keeps a loop from ever false-COMPLETING.
 * For each `when:'loop'` back-edge whose SOURCE stage has just reached 'failed': if the loop HEAD
 * (the edge's ancestor target) still has iterations remaining, re-open the loop — reset the head +
 * its downstream closure (the loop body, up to and through the source) to a clean 'pending' slate,
 * bump the head's `iteration`, and record a `kind:'iteration'` ledger entry. On cap-exhaustion the
 * source is LEFT failed: a loop edge is never a `fail` out-edge, so the skip-aware finalize then
 * fails the pipeline (or, if the author routed the source's forward exit through a gate, that gate
 * parks) — NEVER a false COMPLETED. Returns true when ≥1 loop re-opened (pipeline not quiesced).
 */
function reopenExhaustibleLoops(pipelineRunId: string): boolean {
  const edges = pipelineDb.listEdges.all(pipelineRunId) as PipelineEdgeRow[]
  const loopEdges = edges.filter(e => e.when_cond === 'loop' && e.from_stage_key != null)
  if (loopEdges.length === 0) return false
  const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
  const byKey = new Map(stages.map(s => [s.stage_key, s]))
  // review I-2: reopen each HEAD at most ONCE per drain pass. The validator permits two distinct
  // failed sources to loop back to the SAME head; without this guard each loop edge would reopen +
  // bump the head's iteration, double-counting one logical iteration (and burning the cap twice as
  // fast). The status snapshot above is never refreshed across reopenLoop calls, so we track the
  // heads reopened this pass and skip a repeat rather than re-reading.
  const reopenedHeads = new Set<string>()
  let reopened = false
  for (const le of loopEdges) {
    const source = byKey.get(le.from_stage_key!) // the stage that loops back on failure
    const head = byKey.get(le.to_stage_key)        // the ancestor re-entered
    if (!source || !head) continue
    if (source.status !== 'failed') continue       // only a FAILED loop source triggers a re-entry
    if (reopenedHeads.has(head.stage_key)) continue // already reopened this pass — never double-bump
    // The head runs at most `maxIterations` times: iteration 0 is the first run, each loop-back
    // bumps it, so a re-entry is permitted only while (iteration + 1) < maxIterations. A missing
    // cap (should never happen — the schema requires it) fails CLOSED at 1 (no loop).
    const maxIterations = le.max_iterations ?? 1
    if (head.iteration + 1 >= maxIterations) continue // cap reached — leave the source failed
    reopenLoop(pipelineRunId, head, edges, stages)
    reopenedHeads.add(head.stage_key)
    reopened = true
  }
  return reopened
}

/** Reset a loop body (the head + its out-edge closure) to a clean pending slate and bump the
 *  head's iteration counter, atomically, then record the re-entry on the ledger. */
function reopenLoop(pipelineRunId: string, head: PipelineStageRow, edges: PipelineEdgeRow[], stages: PipelineStageRow[]): void {
  const now = Date.now()
  const nextIteration = head.iteration + 1
  // The loop body = the head plus every stage reachable from it (following the back-edge, this
  // includes the loop source); resetting them re-runs the whole body. Stages downstream of the
  // forward exit are pending during a re-entry (the source failed, so the exit never fired), so
  // resetting them is a harmless no-op. Pre-loop stages feed INTO the head and are NOT in this
  // out-edge closure, so their passed work is preserved.
  const body = downstreamClosure(head.stage_key, edges)
  const tx = db.transaction(() => {
    for (const s of stages) {
      if (!body.has(s.stage_key)) continue
      resetStageForLoop.run({ id: s.id, updatedAt: now })
    }
    bumpStageIteration.run({ id: head.id, iteration: nextIteration, updatedAt: now })
  })
  tx()
  appendLedger(pipelineRunId, {
    stageKey: head.stage_key,
    kind: 'iteration',
    goal: `loop iteration ${nextIteration}`,
    detail: { head: head.stage_key, iteration: nextIteration },
  })
}

export function maybeFinalizePipeline(pipelineRunId: string): void {
  const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow | undefined
  if (!run || run.status !== 'running') return
  markSkips(pipelineRunId)
  const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
  if (stages.length === 0) return

  const inFlight = stages.some(s => s.status === 'dispatched' || s.status === 'running')
  const awaitingGate = stages.some(s => s.status === 'awaiting_gate')
  if (inFlight || awaitingGate) return
  if ((pipelineDb.listReadyStages.all({ pid: pipelineRunId }) as PipelineStageRow[]).length > 0) return

  // orch-p2 A.2 (review I-1): re-enter any bounded loop whose source just failed with iterations
  // remaining — but ONLY once the pipeline has otherwise QUIESCED (the two early-returns above:
  // no in-flight/dispatched stage, no awaiting gate, no ready stage). Running this BEFORE those
  // guards (the original order) let resetStageForLoop clobber a still-running loop-body sibling of
  // the source — its downstream-closure reset NULLed the run_id of a stage whose supervised run was
  // mid-flight, orphaning that run and double-executing it. When the loop source is terminal and
  // nothing else can progress, a loop re-entry is the ONLY remaining forward progress, so deferring
  // it to here is safe. A re-open leaves the loop body 'pending' (not quiesced) → return early; the
  // next scheduler tick re-drives the loop head.
  if (reopenExhaustibleLoops(pipelineRunId)) return

  // Quiesced: no more progress is possible on this tick's DAG. A failed stage is HANDLED iff it
  // has a fail/repair out-edge (the fail branch proceeds — A5 forward routing); an unhandled
  // failed stage (or a leftover pending stage) fails the pipeline. Skipped stages are neutral.
  const edges = pipelineDb.listEdges.all(pipelineRunId) as PipelineEdgeRow[]
  // Only a `fail` out-edge credits a failed stage as "handled" (its fail-branch proceeds). `repair`
  // is EXCLUDED (SEAMS F1): repair routing is deferred + rejected at authoring, and crediting it here
  // would let a failed stage with a repair edge finalize FALSE-COMPLETED even though nothing ran.
  const hasFailOutEdge = (key: string): boolean =>
    edges.some(e => e.from_stage_key === key && e.when_cond === 'fail')
  const unhandledFailure = stages.some(s => s.status === 'failed' && !hasFailOutEdge(s.stage_key))
  const anyPending = stages.some(s => s.status === 'pending') // guard — markSkips should have cleared these
  const now = Date.now()
  const finalStatus: 'completed' | 'failed' = unhandledFailure || anyPending ? 'failed' : 'completed'
  pipelineDb.updatePipelineStatus.run({ id: pipelineRunId, status: finalStatus, updatedAt: now, completedAt: now })
  // A.3 ledger: the run-level terminal — the last entry a reconstruction reads.
  appendLedger(pipelineRunId, {
    stageKey: null, kind: 'transition', actor: null,
    goal: `pipeline ${finalStatus}`, detail: { event: 'pipeline', status: finalStatus },
  })
  // Notify the terminal listeners AFTER the status write commits (the C1 K report-back joins the
  // outcome to its delegating thread). The `run.status !== 'running'` guard above makes this fire
  // exactly once per pipeline — a later tick that re-enters returns before reaching here.
  emitPipelineTerminal(pipelineRunId, finalStatus)
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

// ── gates (A5): resolve a park + insert one dynamically ─────────────────────────────────

/** A guard-violation the HTTP layer (Lane C) maps to 409 Conflict — e.g. inserting a gate
 *  before a stage that has already left 'pending'. Named for recognizability across the seam. */
export class PipelineConflictError extends Error {}

/**
 * Resolve a parked gate stage (A5) — single-resolver CAS. approve→passed, reject→failed, applied
 * ONLY while the stage is still 'awaiting_gate'. Returns true when THIS call resolved it; false
 * when it was already resolved (a lost race — the HTTP layer 409s). On approve the pass branch
 * proceeds next scheduler tick; on reject the fail branch (if any) fail-activates, else the
 * skip-aware finalize fails the pipeline (an unhandled dead-end). K / a risk signal can call this
 * programmatically with the same contract.
 */
export function resolveGate(stageId: string, decision: 'approve' | 'reject', by: string, note?: string): boolean {
  const next = decision === 'approve' ? 'passed' : 'failed'
  const res = pipelineDb.resolveGateStage.run({ id: stageId, next, by, note: note ?? null, now: Date.now() })
  if (res.changes === 1) {
    const stage = pipelineDb.getStage.get(stageId) as PipelineStageRow | undefined
    if (stage) {
      appendLedger(stage.pipeline_run_id, {
        stageKey: stage.stage_key, kind: 'gate', actor: by,
        goal: `gate ${decision}`, detail: { event: 'resolve', decision, by, note: note ?? null },
      })
    }
  }
  return res.changes === 1
}

/**
 * Insert a manual gate stage IMMEDIATELY BEFORE `beforeStageKey` at runtime (A5) — one atomic
 * transaction: guard the target still 'pending' (else a PipelineConflictError the route 409s),
 * insert a fresh kind='gate' stage, REPOINT every edge that targeted the stage onto the gate, then
 * wire gate→beforeStage (share-tree / when='pass'). The gate parks next tick; on approve the
 * original stage proceeds. The synthetic stage_key is a deterministic hash of the inputs (NO
 * Math.random/Date), so it is stable + collision-free across repeated inserts (the stage count
 * salts it). Returns the new gate stage id.
 */
export function insertGate(pipelineRunId: string, beforeStageKey: string, opts: { label?: string; by: string }): string {
  const tx = db.transaction((): string => {
    const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
    const before = stages.find(s => s.stage_key === beforeStageKey)
    if (!before) throw new PipelineConflictError(`insertGate: no stage '${beforeStageKey}' in pipeline ${pipelineRunId}`)
    if (before.status !== 'pending') {
      throw new PipelineConflictError(`insertGate: stage '${beforeStageKey}' is '${before.status}', not pending — cannot insert a gate before it`)
    }
    // Deterministic, collision-free key: hash(pipeline + target + current stage count). The count
    // salts repeated inserts before the same target so each gets a distinct key.
    const gateKey = 'gate-' + createHash('sha1').update(`${pipelineRunId}:${beforeStageKey}:${stages.length}`).digest('hex').slice(0, 8)
    const label = opts.label ?? `Approve before ${beforeStageKey}`
    // Canonicalize a minimal manual-gate StageDef (defaults filled) so the stored spec validates
    // exactly like an authored one when the executor re-parses it.
    const gateSpec = StageDefSchema.parse({ kind: 'gate', id: gateKey, label, gate: { mode: 'manual' } })
    const gateId = randomUUID()
    const now = Date.now()
    pipelineDb.insertStage.run({
      id: gateId, pipelineRunId, stageKey: gateKey, kind: 'gate', profileId: null,
      spec: JSON.stringify(gateSpec), baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now,
    })
    // Order matters: repoint the target's incoming edges onto the gate FIRST, then add the
    // gate→target edge (so the new edge is not itself repointed into a gate→gate self-loop).
    pipelineDb.repointEdgesTo.run({ pid: pipelineRunId, gateKey, beforeKey: beforeStageKey })
    pipelineDb.insertEdge.run({
      id: randomUUID(), pipelineRunId, fromStageKey: gateKey, toStageKey: beforeStageKey,
      handoff: 'share-tree', whenCond: 'pass',
    })
    return gateId
  })
  return tx()
}

// ── operator rewind / retry (C2) ────────────────────────────────────────────────────────

/** The set of stage keys reachable from `startKey` following from→to edges, INCLUDING startKey.
 *  Cycle-safe (visited set). Sink pseudo-keys (`done`) are kept in the set but never match a real
 *  stage row, so they are harmless. */
function downstreamClosure(startKey: string, edges: PipelineEdgeRow[]): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (e.from_stage_key == null) continue
    const list = adj.get(e.from_stage_key) ?? []
    list.push(e.to_stage_key)
    adj.set(e.from_stage_key, list)
  }
  const seen = new Set<string>([startKey])
  const stack = [startKey]
  while (stack.length) {
    const cur = stack.pop()!
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next) }
    }
  }
  return seen
}

/**
 * OPERATOR-triggered rewind/retry (C2): reset `stageKey` AND every stage transitively DOWNSTREAM
 * of it to a clean 'pending' slate (drop run_id / result_commit / exit_code / failure_class /
 * timestamps; the target also resets retry_count), then — if the pipeline had already finalized —
 * reopen it to 'running' so the scheduler re-drives from the reset stage on its next tick. This is
 * operator-initiated (no loop budget — distinct from the DEFERRED automatic repair-loop back-edge);
 * the manual "retry a failed stage" action is a rewind AT that stage. One atomic transaction.
 * Throws PipelineConflictError (the route maps to 404) for an unknown pipeline or stage.
 */
export function rewindPipelineToStage(pipelineRunId: string, stageKey: string): void {
  const tx = db.transaction((): void => {
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow | undefined
    if (!run) throw new PipelineConflictError(`rewindPipelineToStage: no pipeline ${pipelineRunId}`)
    const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
    const target = stages.find(s => s.stage_key === stageKey)
    if (!target) throw new PipelineConflictError(`rewindPipelineToStage: no stage '${stageKey}' in pipeline ${pipelineRunId}`)

    const edges = pipelineDb.listEdges.all(pipelineRunId) as PipelineEdgeRow[]
    const toReset = downstreamClosure(stageKey, edges) // includes the target itself

    const now = Date.now()
    for (const s of stages) {
      if (!toReset.has(s.stage_key)) continue
      rewindResetStage.run({ id: s.id, updatedAt: now })
      if (s.stage_key === stageKey) rewindResetTargetRetry.run({ id: s.id, updatedAt: now })
    }
    // Reopen a COMPLETED/FAILED pipeline for the re-run (a still-running one is left running); clear
    // completed_at. A `cancelled` pipeline is NOT resurrected — a deliberate cancel stays terminal
    // (SEAMS NIT); rewinding a cancelled run resets the stages but leaves the pipeline cancelled.
    if (run.status === 'completed' || run.status === 'failed') {
      pipelineDb.updatePipelineStatus.run({ id: pipelineRunId, status: 'running', updatedAt: now, completedAt: null })
    }
  })
  tx()
}

// ── status writers (one place to keep the completed_at/updated_at bookkeeping) ──────────

function markStagePassed(stageId: string, resultCommit: string | null, exitCode: number | null): void {
  const now = Date.now()
  pipelineDb.markStagePassed.run({ id: stageId, resultCommit, exitCode, costUsd: null, updatedAt: now, completedAt: now })
  ledgerStageTerminal(stageId, 'passed')
}

function markStageFailed(stageId: string, failureClass: string | null, exitCode: number | null): void {
  const now = Date.now()
  pipelineDb.markStageFailed.run({ id: stageId, failureClass, exitCode, costUsd: null, updatedAt: now, completedAt: now })
  ledgerStageTerminal(stageId, 'failed')
}

// ── ledger instrumentation (A.3) ────────────────────────────────────────────────────────
//
// Every engine transition writes a PipelineLedgerEntry so a run reconstructs from its ledger
// alone (design §6.1). The status writers above own the TERMINAL entries (one place, so every
// path — supervised terminal, retry-exhaust, reconcile, merge-conflict — is covered uniformly);
// dispatch / gate / retry / pipeline-terminal entries are emitted at their own seams.

/** Best-effort actor label for a stage's ledger entries: an agent stage's subagentType or role,
 *  else the stage kind. Parses the frozen StageDef spec defensively (never throws). */
function stageActor(stage: PipelineStageRow): string {
  try {
    const def = JSON.parse(stage.spec) as { kind?: string; subagentType?: string | null; role?: string }
    if (def?.kind === 'agent') return def.subagentType ?? def.role ?? 'agent'
  } catch { /* fall through to the kind */ }
  return stage.kind
}

/** Record a stage's terminal transition (+ an `artifact` entry when it produced a handoff commit).
 *  Re-reads the freshly-updated row so result/exit/cost reflect the write that just committed. */
function ledgerStageTerminal(stageId: string, status: 'passed' | 'failed'): void {
  const stage = pipelineDb.getStage.get(stageId) as PipelineStageRow | undefined
  if (!stage) return
  appendLedger(stage.pipeline_run_id, {
    stageKey: stage.stage_key,
    kind: 'transition',
    actor: stageActor(stage),
    goal: `${stage.stage_key} ${status}`,
    cost: stage.cost_usd,
    detail: { event: 'terminal', status, kind: stage.kind, resultCommit: stage.result_commit, exitCode: stage.exit_code, failureClass: stage.failure_class },
  })
  if (status === 'passed' && stage.result_commit) {
    appendLedger(stage.pipeline_run_id, {
      stageKey: stage.stage_key, kind: 'artifact', actor: stageActor(stage),
      goal: `${stage.stage_key} handoff`, detail: { resultCommit: stage.result_commit },
    })
  }
}
