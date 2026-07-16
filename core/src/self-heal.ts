/**
 * E-18 self-healing runs. On a terminal FAILED run that is an org/auto activation
 * (has an agent_runs row) and eligible (selfHeal on, retry_count < MAX_RETRIES,
 * classified retryable, budget headroom), re-dispatch it with a model fallback and
 * stamp retry lineage (retry_of/retry_count). Otherwise PARK: create an Inbox
 * proposal ('self_heal:<runId>') with a ONE-LINE deterministic diagnosis. The
 * retry-rate metric becomes real off runs.retry_of. Mirrors chief-wake's exported
 * body + start/stop shape; never throws into the event loop.
 */
import type { Run, FailureClass } from '@k/shared'
import { randomUUID } from 'crypto'
import { eventBus } from './events.js'
import { isTerminalRunStatus } from './run-lifecycle.js'
import { runsDb, retryDb, agentRunsDb, eventsDb, proposalsDb } from './db.js'
import { classifyFailure, fallbackModel, isRetryable } from './failure-classifier.js'
import { OPEN_PROPOSAL_CAP } from './proposal-collectors.js'
import { autonomySettings } from './config-store.js'
import { budgetGate } from './budget-governor.js'
import { startRun } from './supervisor.js'

export const MAX_RETRIES = 2

/** The stderr/diagnosis text for a run: the `text` of its last type='error' event (the only
 *  place error text lives — supervisor.ts:992-996). A clean non-zero exit persists NO such
 *  event → returns null → classifyFailure → 'unknown' → not retryable → park. */
function runErrorText(runId: string): string | null {
  const ev = eventsDb.latestErrorEvent.get(runId) as { text?: string | null } | undefined
  return ev?.text ?? null
}

/**
 * The ONE retry-decision brain (D-119 A4). Classify a terminal FAILED run into its
 * FailureClass, PERSIST that class on the run (runs.failure_class), and derive the retry
 * decision: a model fallback (fallbackModel — capacity → downgrade a tier, transient/timeout
 * → same model, non-retryable → null) plus whether the class is auto-retryable. Shared by the
 * global self-heal subscriber (below) and the pipeline engine's per-stage retry, so both
 * classify + fall back IDENTICALLY. `stderr` is the run's last error-event text (null for a
 * clean non-zero exit → 'unknown' → not retryable).
 */
export function classifyRunFailure(
  run: { id: string; status: string; model?: string | null },
): { cls: FailureClass; fallbackModel: string | null; retryable: boolean } {
  const cls = classifyFailure({ status: run.status, stderr: runErrorText(run.id) })
  retryDb.setRunFailureClass.run({ id: run.id, failureClass: cls })
  return { cls, fallbackModel: fallbackModel(run.model ?? 'claude-sonnet-4-6', cls), retryable: isRetryable(cls) }
}

/**
 * Stamp a retry run's lineage (runs.retry_of/retry_count) and broadcast run_retried, so the
 * retry-rate metric (real off runs.retry_of) + the live UI see the descend. The announced
 * failureClass rides the ORIGINAL run's just-persisted failure_class (classifyRunFailure runs
 * first on every retry path, so it is always set). Shared by self-heal + the pipeline engine.
 */
export function stampRetryLineage(newRunId: string, originalRunId: string, newRetryCount: number): void {
  retryDb.setRunRetry.run({ id: newRunId, retryOf: originalRunId, retryCount: newRetryCount })
  const cls = (runsDb.getRun.get(originalRunId) as { failure_class?: FailureClass | null } | undefined)?.failure_class ?? 'unknown'
  eventBus.broadcast({ type: 'run_retried', originalRunId, retryRunId: newRunId, failureClass: cls })
}

export async function onRunTerminalForHeal(run: Run, now = Date.now()): Promise<'retried' | 'parked' | 'skipped'> {
  const s = autonomySettings()
  if (!s.enabled || !s.selfHeal) return 'skipped'
  // Act only on genuine execution failures. A clean finish ('done') and a deliberate
  // stop ('killed'/'interrupted') are not failures — never retry or park them (else an
  // operator-cancelled org run parks Inbox noise).
  if (!isTerminalRunStatus(run.status) || run.status === 'done' || run.status === 'killed' || run.status === 'interrupted') return 'skipped'
  // Eligible: an org/auto run (has an agent_runs owner) OR a descended retry. A retry is
  // dispatched via startRun and gets NO agent_runs row of its own, so without the retry_of
  // branch a failed retry would find no owner → be orphaned (never re-healed, never parked)
  // and the retry ladder could never climb past retry_count=1.
  const owner = agentRunsDb.getAgentRunProfileByRunId.get(run.id) as { profile_id?: string } | undefined
  const row = runsDb.getRun.get(run.id) as { model?: string; retry_count?: number; prompt?: string; project_id?: string | null; retry_of?: string | null; cwd?: string | null; pipeline_stage_id?: string | null } | undefined
  if (!row) return 'skipped'
  // D-119 ownership guard (§10, MANDATORY): a pipeline stage's run is retried by the ENGINE
  // (pipeline-engine.ts::handleStageFailure) via the SAME retry brain below, NEVER here — else
  // it DOUBLE-FIRES (one retry from the engine's trackSupervisedRun finalize, one from this
  // global subscriber). The back-ref is stamped on EVERY run the engine dispatches (originals +
  // retries) and never overwritten, so a failed ORIGINAL is still recognized as pipeline-owned
  // even after a retry overwrote the stage's run_id (which is why the guard keys on the per-run
  // back-ref, not pipeline_stages.run_id).
  if (row.pipeline_stage_id) return 'skipped'
  if (!owner?.profile_id && !row.retry_of) return 'skipped'

  const { cls, fallbackModel: fb, retryable } = classifyRunFailure({ id: run.id, status: run.status, model: row.model })
  const retryCount = row.retry_count ?? 0
  const headroom = budgetGate({ projectId: row.project_id ?? null }).allowed

  if (retryable && retryCount < MAX_RETRIES && fb && headroom) {
    try {
      // Preserve the original run's working dir — else startRun defaults cwd to REPO_ROOT (K's own
      // repo), so a project-scoped retry would run the project goal against K's codebase.
      const retry = await startRun(String(row.prompt ?? ''), { model: fb, projectId: row.project_id ?? undefined, cwd: row.cwd ?? undefined })
      stampRetryLineage(retry.id, run.id, retryCount + 1)
      return 'retried'
    } catch (e) {
      console.warn('[self-heal] retry dispatch failed:', e)
      // fall through to park
    }
  }
  // Park: one Inbox proposal with a one-line diagnosis (deduped by source_key).
  // P5 SEAMS minor (cap-bypass edge): this direct insert must respect the same
  // OPEN_PROPOSAL_CAP the collectors enforce — an unbounded park flood could bury
  // the inbox. When full, log and skip (the run row + failure_class still record it).
  if (!proposalsDb.getProposalBySourceKey.get(`self_heal:${run.id}`)) {
    if ((proposalsDb.countOpenProposals.get() as { n: number }).n >= OPEN_PROPOSAL_CAP) {
      console.warn(`[self-heal] proposal cap reached — not parking run ${run.id} (${cls})`)
      return 'parked'
    }
    const stderr = runErrorText(run.id)
    proposalsDb.insertProposal.run({
      id: randomUUID(), title: `Failed run needs attention (${cls})`,
      body: `Run ${run.id} ended ${run.status}. Diagnosis: ${(stderr ?? 'no error output').slice(0, 200)}`,
      projectId: row.project_id ?? null, source: 'verify_finding', sourceKey: `self_heal:${run.id}`, createdAt: now,
    })
    eventBus.broadcast({ type: 'proposal_update' })
  }
  return 'parked'
}

export function startSelfHeal(): () => void {
  const off = eventBus.onRunUpdate(run => {
    if (!isTerminalRunStatus(run.status) || run.status === 'done' || run.status === 'killed' || run.status === 'interrupted') return
    void onRunTerminalForHeal(run).catch(() => { /* never crash the bus */ })
  })
  return off
}
