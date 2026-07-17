/**
 * pipeline-scheduler.ts — the MAIN-process DAG driver for running pipelines (D-119 Lane A,
 * wave A3). Modeled 1:1 on lead-dispatch-relay.ts: an exported, directly-unit-testable body
 * (drainPipelines) plus a start/stop wiring fn (startPipelineScheduler) with an env opt-out
 * and an unref'd interval so the loop never keeps the process alive.
 *
 * Per running pipeline, per tick: dead-branch untaken/unreachable pending stages (markSkips,
 * A5), then list the READY pending stages (listReadyStages — AND-join of always/pass predecessors
 * OR a fail-activated stage whose fail source failed); for each, gate an AGENT stage on the budget
 * (budgetGate) + a global in-flight concurrency cap (autonomySettings.maxConcurrency), then
 * atomically CLAIM it (pending→dispatched; changes===0 ⇒ another drain won, skip) and
 * dispatchStage it. After the ready sweep, maybeFinalizePipeline retires a quiesced pipeline.
 *
 * ── Concurrency + failure model (mirrors the lead relay) ────────────────────────────────
 *  • Re-entrancy latch: a module-level `draining` flag makes an overlapping tick a no-op.
 *  • Atomic claim: claimStage is a conditional UPDATE — a stage dispatches exactly once.
 *  • Never crashes the tick: a dispatchStage throw settles the stage failed and degrades;
 *    the interval callback `.catch()`es anything that still escapes.
 *  • Concurrency cap is GLOBAL (across all pipelines) and re-read each iteration — claimStage
 *    flips the row to 'dispatched' synchronously, so the next count already includes it (no
 *    snapshot/double-count arithmetic needed, unlike the async-insert backlog relay).
 */

import { db, pipelineDb } from './db.js'
import { autonomySettings } from './config-store.js'
import { budgetGate } from './budget-governor.js'
import { dispatchStage, markSkips, maybeFinalizePipeline, type PipelineRunRow } from './pipeline-engine.js'
import { broadcastPipelineUpdate } from './pipeline-views.js'
import { appendLedger } from './pipeline-ledger.js'
import type { PipelineStageRow } from './pipeline-executor.js'

const DEFAULT_PIPELINE_INTERVAL_MS = 3_000

// Re-entrancy latch: true while a drain is in flight so an overlapping interval tick (or a
// manual test call) is a no-op instead of racing the same ready stages.
let draining = false

// Global in-flight AGENT-stage count = the maxConcurrency budget for paid stage dispatches.
// Deterministic/gate/hook-script stages are zero-token and NOT capped. Local prepared
// statement (the backlog-relay precedent) so db.ts's W0 pipelineDb bundle stays frozen.
const countInFlightAgentStages = db.prepare(
  `SELECT COUNT(*) AS n FROM pipeline_stages WHERE kind = 'agent' AND status IN ('dispatched','running')`,
)
function inFlightAgentStages(): number {
  return (countInFlightAgentStages.get() as { n: number }).n
}

/**
 * Drain every running pipeline once: dispatch its ready stages (budget + concurrency gated
 * for agent stages), then finalize the ones that have quiesced. Never throws — a per-stage
 * dispatch failure settles that stage failed and degrades. Returns stages dispatched.
 */
export async function drainPipelines(): Promise<number> {
  if (draining) return 0
  draining = true
  try {
    let dispatched = 0
    const maxConcurrency = autonomySettings().maxConcurrency
    for (const run of pipelineDb.listRunningPipelines.all() as PipelineRunRow[]) {
      // A5: dead-branch untaken / unreachable pending stages to a fixpoint BEFORE readiness, so a
      // skipped stage never dispatches and readiness/finalize see the settled skip state.
      markSkips(run.id)
      let dispatchedThisPipeline = 0
      const ready = pipelineDb.listReadyStages.all({ pid: run.id }) as PipelineStageRow[]
      for (const stage of ready) {
        // Agent (paid, model-driven) stages re-check the measured budget + the global
        // concurrency cap every dispatch (§10 fan-out/retry-burst guard). A blocked agent
        // stage is left pending — the next tick retries it once headroom frees up.
        if (stage.kind === 'agent') {
          if (!budgetGate({ projectId: run.project_id }).allowed) continue
          if (inFlightAgentStages() >= maxConcurrency) continue
        }
        // Atomic claim: only the drain that flips pending→dispatched proceeds.
        const now = Date.now()
        if (pipelineDb.claimStage.run({ id: stage.id, updatedAt: now, startedAt: now }).changes === 0) continue
        try {
          await dispatchStage(run, stage)
          dispatched++
          dispatchedThisPipeline++
        } catch (err) {
          // A dispatch throw must never crash the drain: the claimed stage is settled failed
          // (never left stranded 'dispatched') and the loop degrades.
          pipelineDb.markStageFailed.run({
            id: stage.id, failureClass: null, exitCode: null, costUsd: null,
            updatedAt: Date.now(), completedAt: Date.now(),
          })
          // A.3 ledger: this direct settle bypasses the engine's markStageFailed instrumentation.
          appendLedger(run.id, {
            stageKey: stage.stage_key, kind: 'transition', actor: stage.kind,
            goal: `${stage.stage_key} failed`, detail: { event: 'terminal', status: 'failed', reason: 'dispatch-threw' },
          })
          console.warn(`[pipeline-scheduler] stage ${stage.id} dispatch failed:`, err)
        }
      }
      maybeFinalizePipeline(run.id)
      // C2: nudge the live DAG once per pass that dispatched a stage (dispatched/running flips).
      // Pipeline FINALIZE is broadcast separately via the onPipelineTerminal boot listener
      // (startPipelineUpdateBroadcast), so the engine writers stay uncoupled from the WS.
      if (dispatchedThisPipeline > 0) broadcastPipelineUpdate(run.id, null)
    }
    return dispatched
  } finally {
    draining = false
  }
}

/**
 * Start the MAIN-process pipeline scheduler: drain running pipelines on an interval. Returns
 * a stop fn that clears the interval (mirrors startLeadDispatchRelay). Opt out via
 * PIPELINE_SCHEDULER=0 (returns a no-op stop). The interval is unref'd so it never keeps the
 * process alive on its own.
 */
export function startPipelineScheduler(opts?: { intervalMs?: number }): () => void {
  if (process.env.PIPELINE_SCHEDULER === '0') return () => { /* disabled — nothing wired */ }
  const intervalMs = opts?.intervalMs ?? (Number(process.env.PIPELINE_SCHEDULER_INTERVAL_MS) || DEFAULT_PIPELINE_INTERVAL_MS)
  const timer = setInterval(() => { void drainPipelines().catch(() => { /* never crash the tick */ }) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
