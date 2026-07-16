/**
 * E-18 self-healing runs. On a terminal FAILED run that is an org/auto activation
 * (has an agent_runs row) and eligible (selfHeal on, retry_count < MAX_RETRIES,
 * classified retryable, budget headroom), re-dispatch it with a model fallback and
 * stamp retry lineage (retry_of/retry_count). Otherwise PARK: create an Inbox
 * proposal ('self_heal:<runId>') with a ONE-LINE deterministic diagnosis. The
 * retry-rate metric becomes real off runs.retry_of. Mirrors chief-wake's exported
 * body + start/stop shape; never throws into the event loop.
 */
import type { Run } from '@k/shared'
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
  const row = runsDb.getRun.get(run.id) as { model?: string; retry_count?: number; prompt?: string; project_id?: string | null; retry_of?: string | null; cwd?: string | null } | undefined
  if (!row) return 'skipped'
  if (!owner?.profile_id && !row.retry_of) return 'skipped'
  const stderr = runErrorText(run.id)
  const cls = classifyFailure({ status: run.status, stderr })
  retryDb.setRunFailureClass.run({ id: run.id, failureClass: cls })

  const retryCount = row.retry_count ?? 0
  const model = row.model ?? 'claude-sonnet-4-6'
  const fb = fallbackModel(model, cls)
  const headroom = budgetGate({ projectId: row.project_id ?? null }).allowed

  if (isRetryable(cls) && retryCount < MAX_RETRIES && fb && headroom) {
    try {
      // Preserve the original run's working dir — else startRun defaults cwd to REPO_ROOT (K's own
      // repo), so a project-scoped retry would run the project goal against K's codebase.
      const retry = await startRun(String(row.prompt ?? ''), { model: fb, projectId: row.project_id ?? undefined, cwd: row.cwd ?? undefined })
      retryDb.setRunRetry.run({ id: retry.id, retryOf: run.id, retryCount: retryCount + 1 })
      eventBus.broadcast({ type: 'run_retried', originalRunId: run.id, retryRunId: retry.id, failureClass: cls })
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
