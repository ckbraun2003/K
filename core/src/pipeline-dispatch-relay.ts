/**
 * pipeline-dispatch-relay.ts — the MAIN-process drain for the K/Chief→pipeline dispatch queue (C1).
 *
 * WHY THIS EXISTS (the child→main decoupling)
 * -------------------------------------------
 * The kstore `delegate_pipeline` tool runs inside the ephemeral per-K/Chief-run stdio MCP CHILD
 * process. If that tool started the pipeline DIRECTLY, the whole DAG would be owned by a process
 * that dies the moment the delegating turn ends: the pipeline SCHEDULER that walks the running
 * pipeline, every supervised stage run's tracking-row lifecycle, and each stage's report-back all
 * live in the long-lived MAIN process, so a child-started pipeline would be orphaned at turn end.
 *
 * The fix mirrors the PROVEN Chief→lead relay (lead-dispatch-relay.ts): `delegate_pipeline` (in the
 * child) only RECORDS a 'pending' row in the DB-backed `pipeline_dispatches` queue. This relay —
 * started once in the MAIN process at boot (index.ts) — polls that queue and does the actual
 * EXECUTION here via startPipelineRun, where the scheduler + report-back live in a process that
 * stays up. The child and main are SEPARATE processes sharing one SQLite DB file, so the hand-off
 * MUST be DB-backed: an in-process EventBus would not cross the process boundary.
 *
 * ── Concurrency + failure model (identical to the lead relay) ──────────────────────
 *  • Re-entrancy guard: a module-level `draining` latch makes an overlapping drain a no-op.
 *  • Atomic claim: each pending row is claimed via a conditional UPDATE (pending→dispatched); if
 *    `.changes === 0` another drain already claimed it, so it is skipped — executed exactly once.
 *  • Project scope: the dispatch's pinned project_id is resolved to a cwd at EXECUTION time
 *    (resolveDispatchScope reused — project→cwd, fail-closed on a vanished registry entry / path);
 *    an unscoped dispatch runs against K's own repo (REPO_ROOT). FAIL-CLOSED on a non-git cwd:
 *    startPipelineRun → resolveHeadCommit throws, caught by the outer degrade below.
 *  • Dispatch failure: startPipelineRun throwing (non-git cwd, bad definition, scope reads) marks
 *    the claimed intent 'failed' and degrades — a bad intent never crashes the loop. A crash in the
 *    claim→setPipelineDispatchRun window leaves the row 'dispatched' with no pipeline_run_id, which
 *    the boot sweep (reconcileOrphanedPipelineDispatches) finalizes 'failed'.
 *
 * Report-back to K is NOT wired here (a pipeline is MULTI-run — there is no single supervised run to
 * ride at dispatch time). It is a GLOBAL engine terminal listener wired once at boot instead
 * (k-thread.ts::continuePipelineOutcomeToK via pipeline-engine.ts::onPipelineTerminal), which joins
 * a terminal pipeline back to this dispatch's k_run_id.
 */

import { pipelineDb } from './db.js'
import { startPipelineRun } from './pipeline-defs.js'
import { getProject } from './projects.js'
import { resolveDispatchScope } from './lead-dispatch-relay.js'
import { REPO_ROOT } from './supervisor.js'

/** Default poll interval for the relay (ms). Overridable via env; read lazily inside
 *  startPipelineDispatchRelay so it can be set after import (mirrors the lead relay). */
const DEFAULT_RELAY_INTERVAL_MS = 2_000

// Re-entrancy latch: true while a drain is in flight so an overlapping interval tick (or a manual
// call) is a no-op instead of racing the same pending rows.
let draining = false

/**
 * Drain the pending pipeline-dispatch queue: for each pending intent, atomically claim it
 * (pending→dispatched) then EXECUTE it here in the main process via startPipelineRun. On success,
 * record the started pipeline_run_id on the intent (so the K report-back can join a terminal
 * pipeline to its k_run_id). Never throws — a dispatch failure marks the intent 'failed' and
 * degrades. Returns the number of intents successfully dispatched.
 */
export async function drainPipelineDispatches(): Promise<number> {
  if (draining) return 0
  draining = true
  try {
    const rows = pipelineDb.listPendingPipelineDispatches.all() as Array<Record<string, unknown>>
    let dispatched = 0
    for (const row of rows) {
      const id = String(row.id)
      // Atomic claim: only the drain whose UPDATE actually flips pending→dispatched may execute
      // this intent. A concurrent/overlapping drain sees changes===0 and skips.
      if (pipelineDb.claimPipelineDispatch.run({ id, dispatchedAt: Date.now() }).changes === 0) continue

      try {
        // Resolve the pinned project scope at EXECUTION time (mirrors the lead relay). A scoped
        // dispatch maps its stored project_id → the registry name → resolveDispatchScope, which
        // applies the SAME fail-closed check (project gone / localPath vanished FAILS the dispatch
        // cleanly). An unscoped dispatch runs against K's own repo. This runs INSIDE the try so a
        // THROW here (e.g. SQLITE_BUSY on the registry read) degrades through the same catch below
        // rather than stranding the row 'dispatched' until the boot sweep.
        let projectId: string | null = null
        let cwd = REPO_ROOT
        if (row.project_id != null) {
          const project = getProject(String(row.project_id))
          // Pass the id itself when the project row is gone so resolveDispatchScope fails it cleanly.
          const scope = resolveDispatchScope([project ? project.name : String(row.project_id)])
          if (scope.error || !scope.cwd) {
            pipelineDb.markPipelineDispatchFailed.run({ id, dispatchedAt: Date.now() })
            console.warn(`[pipeline-relay] dispatch ${id} failed: ${scope.error ?? 'scoped project resolved no cwd'}`)
            continue
          }
          projectId = scope.projectId
          cwd = scope.cwd
        }

        // Instantiate the pipeline in the MAIN process (the scheduler that walks it + every stage's
        // report-back outlive the MCP child that recorded the intent). The scheduler's interval
        // picks up the new running pipeline on its next tick, exactly like the operator route will.
        const { pipelineRunId } = await startPipelineRun(String(row.pipeline_id), {
          goal: String(row.goal),
          projectId,
          cwd,
          model: row.model != null ? String(row.model) : undefined,
        })
        dispatched++
        // Record the started pipeline on the intent so continuePipelineOutcomeToK can join the
        // terminal pipeline back to this dispatch's k_run_id. A throw here would leave the pipeline
        // LIVE but the intent stranded 'dispatched' with no run id — the exact orphan the boot sweep
        // rescues — so it is the last step and any failure degrades through the outer catch.
        pipelineDb.setPipelineDispatchRun.run({ id, pipelineRunId })
      } catch (err) {
        // startPipelineRun threw (non-git cwd, unknown definition, or the scope reads) — the intent
        // is claimed 'dispatched': mark it 'failed' (never re-pending, so a crash after the pipeline
        // was instantiated can't double-execute) and degrade.
        pipelineDb.markPipelineDispatchFailed.run({ id, dispatchedAt: Date.now() })
        console.warn(`[pipeline-relay] dispatch ${id} failed:`, err)
      }
    }
    return dispatched
  } finally {
    draining = false
  }
}

/**
 * Start the MAIN-process pipeline-dispatch relay: poll the pending queue on an interval and drain
 * it. Returns a stop fn that clears the interval (mirrors startLeadDispatchRelay). Opt out via
 * PIPELINE_DISPATCH_RELAY=0 (returns a no-op stop, wiring nothing). The interval is unref'd so the
 * relay never keeps the process alive on its own; it is INERT until a pipeline is delegated.
 */
export function startPipelineDispatchRelay(opts?: { intervalMs?: number }): () => void {
  if (process.env.PIPELINE_DISPATCH_RELAY === '0') return () => { /* disabled — nothing wired */ }

  const intervalMs =
    opts?.intervalMs ?? (Number(process.env.PIPELINE_DISPATCH_RELAY_INTERVAL_MS) || DEFAULT_RELAY_INTERVAL_MS)
  const timer = setInterval(() => { void drainPipelineDispatches().catch(() => { /* never crash the tick */ }) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
