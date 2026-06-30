/**
 * Run-lifecycle seam — the shared "supervised-run completion lifecycle".
 *
 * WHY THIS EXISTS
 * ---------------
 * Three call sites — workflows.ts::dispatchTaskWorkflow, skills.ts::triggerSkill,
 * and skills.ts::runSkillTest — each (a) insert a tracking row with no runId,
 * (b) `await startRun(...)`, then (c) run the IDENTICAL completion dance: patch
 * the runId onto the tracking row, subscribe to run updates, and finalize the
 * tracking row exactly once when the run reaches a terminal status. That dance
 * was copy-pasted 3× (each with its own `TERMINAL` set), so a fix to one (e.g.
 * the await/subscribe race backstop) had to be hand-ported to the others — and
 * wasn't always (triggerSkill lacked the backstop). This module unifies the
 * dance behind ONE function so there is a single place to get it right.
 *
 * THE SUBTLE PARTS (both folded in here so callers never re-derive them)
 * ---------------------------------------------------------------------
 *  1. unsub-BEFORE-finalize: the subscriber unsubscribes itself *before* writing
 *     the finalize, so a duplicate terminal event delivered in the same tick
 *     cannot re-enter and finalize twice. A `finalizeOnce` latch backstops that
 *     too (belt and suspenders).
 *  2. the await/subscribe race backstop: `startRun` can drive the run to a
 *     terminal status BEFORE we manage to subscribe (the terminal event fires
 *     during the `await`, with no listener yet). If we only subscribed we'd leak
 *     a forever-'running'/'pending' tracking row. So after subscribing we re-read
 *     the run's current status straight from the DB and, if already terminal,
 *     finalize immediately. `finalizeOnce` guarantees this and the subscriber
 *     never both fire.
 *
 * WHAT THE CALLER STILL OWNS (this seam is deliberately narrow)
 * ------------------------------------------------------------
 *  - inserting the tracking row (no runId yet) and calling `await startRun`;
 *  - the dispatch-failure degrade path (the try/catch around startRun) — this
 *    seam only handles the SUCCESS path AFTER startRun returns a run;
 *  - mapping the terminal RUN status → its own row status (done→completed/pass,
 *    etc.) inside the `finalize` hook;
 *  - patching the runId onto its specific tracking row inside the `onStarted`
 *    hook.
 *
 * This is the seam a future `startAgentRun` will ride: it centralizes the
 * "watch a supervised run to terminal and finalize once" contract so new run
 * kinds can plug in onStarted/finalize hooks without re-implementing the race
 * handling.
 *
 * Imports ONLY runsDb (DB re-read for the backstop) and eventBus (subscribe) —
 * deliberately NOT supervisor.ts, to avoid an import cycle (supervisor is the
 * primitive this seam's callers invoke).
 */

import { runsDb } from './db.js'
import { eventBus } from './events.js'

/** The single source of truth for terminal run statuses (replaces the 3 local
 *  copies that lived in dispatchTaskWorkflow / runSkillTest / triggerSkill). */
export const TERMINAL_RUN_STATUSES = new Set(['done', 'error', 'killed', 'interrupted'])

/** True iff `status` is a non-null terminal run status. A type-guard so callers
 *  narrow `string | undefined` → `string` without a non-null assertion. */
export function isTerminalRunStatus(status: string | null | undefined): status is string {
  return status != null && TERMINAL_RUN_STATUSES.has(status)
}

/** Hooks a caller supplies to bind the shared lifecycle to its own tracking row. */
export interface SupervisedRunLifecycle {
  /** Patch the now-known runId onto the caller's already-inserted tracking row. */
  onStarted(runId: string): void
  /** Map the terminal RUN status to the caller's row status and persist it.
   *  Invoked AT MOST ONCE per supervised run. */
  finalize(terminalStatus: string): void
}

/**
 * Wire the supervised-run completion lifecycle for a run that has just started.
 *
 * Order of operations (matters):
 *   1. `onStarted(runId)` — caller patches the runId onto its tracking row.
 *   2. subscribe to run updates; on the run's terminal event, unsubscribe FIRST,
 *      then finalize once.
 *   3. backstop the await/subscribe race: if the run already reached terminal
 *      before step 2 subscribed, finalize now (once).
 *
 * `finalize` is guaranteed to run at most once across the subscriber and the
 * backstop.
 */
export function trackSupervisedRun(runId: string, hooks: SupervisedRunLifecycle): void {
  hooks.onStarted(runId)

  let finalized = false
  const finalizeOnce = (status: string): void => {
    if (finalized) return
    finalized = true
    hooks.finalize(status)
  }

  // unsub() runs BEFORE the finalize write so a duplicate terminal event can't
  // re-finalize the row.
  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== runId || !isTerminalRunStatus(r.status)) return
    unsub()
    finalizeOnce(r.status)
  })

  // Backstop the await/subscribe race: if the run already reached a terminal
  // state before we subscribed, finalize now instead of leaking a non-terminal
  // tracking row.
  const currentStatus = (runsDb.getRun.get(runId) as { status?: string } | undefined)?.status
  if (isTerminalRunStatus(currentStatus)) {
    unsub()
    finalizeOnce(currentStatus)
  }
}
