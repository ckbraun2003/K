/**
 * Chief autonomous wake (P5.2b, bible §03 D-023 triggers) — Chief-side only.
 *
 * The Chief tier is DURABLE but only ever RUNS as a bounded activation. This module
 * makes it WAKE ON ITS OWN: a scheduler tick (node-cron) OR a subscribed terminal
 * run-completion event fires the existing `startAgentRun('chief', { trigger })`
 * primitive. It rebuilds NOTHING — it wires the Phase-3 scheduler (mirrors
 * skills.ts::startScheduler) and the EventBus (mirrors graph.ts::registerGraphAutoReindex)
 * to the existing activation path. K→Chief delegation is deliberately OUT OF SCOPE
 * (it touches K's routing — a later slice).
 *
 * ── D-044: reuse `agent_runs` as the wake ledger (NO new table) ──────────────────
 * A "Chief wake" IS an `agent_runs` row: profile_id='chief', trigger ∈ {schedule,event},
 * created by `startAgentRun('chief', …)`. The four things a wake ledger needs map 1:1
 * onto existing columns — trigger kind=`trigger`, time=`created_at`, resulting run
 * id=`run_id`, outcome=`status`. `startAgentRun` already inserts the row 'running',
 * patches run_id, finalizes on terminal, and (its rollback contract) rolls the row
 * back to 'failed' + re-throws on a dispatch throw. The chief route already READS these
 * via `listRecentAgentRunsByProfile('chief', …)` (`chiefWakes`), and the ChiefPage
 * WakeRow already renders trigger/goal/run-link/status/time — so the UI slot is wired;
 * this module only makes the wakes EXIST.
 *
 * ── Two guards + a self-wake guard + failure-degrade ─────────────────────────────
 *  • Guard A (min-interval debounce): a burst of ticks/events collapses to one wake —
 *    `lastWakeAt` is set SYNCHRONOUSLY before the await so a synchronous burst is
 *    debounced deterministically.
 *  • Guard B (already-running / idempotent): if a chief run is already 'running',
 *    a new wake is skipped — one Chief activation at a time.
 *  • Self-wake guard (`onChiefWakeRunUpdate`): the Chief's OWN run finishing must NOT
 *    wake the Chief again, or a wake→run→complete→wake loop forms.
 *  • Failure-degrade: `startAgentRun` records the row 'failed' + re-throws on a dispatch
 *    failure; `wakeChief` SWALLOWS that (returns {woke:false,reason:'failed'}) so the
 *    cron/event callback never crashes the loop — while the ledger still shows 'failed'.
 */

import { schedule as cronSchedule, validate as cronValidate } from 'node-cron'
import type { Run } from '@k/shared'
import { eventBus } from './events.js'
import { startAgentRun } from './agent-runs.js'
import { agentRunsDb } from './db.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

/** The Chief's default schedule-wake instruction (the `-p` seed for a cron wake). */
export const DEFAULT_CHIEF_WAKE_GOAL =
  'Autonomous org check-in: review active leads, in-flight workflows, and open objectives; ' +
  'surface blockers, and note any unstaffed work. Report a concise status; do not dispatch new work yet.'

/** Default cron for the Chief's scheduled wake (every 15 minutes). A literal default;
 *  the `CHIEF_WAKE_CRON` env override is read lazily inside startChiefWake() so it can
 *  be set after import (mirroring the lazy chiefWakeEnabled() read). */
export const DEFAULT_CHIEF_WAKE_CRON = '*/15 * * * *'

/** The outcome of a wake attempt. A success carries the ledger row id + the run id;
 *  a skip/failure carries a machine-readable reason. */
export type WakeOutcome =
  | { woke: true; agentRunId: string; runId: string }
  | { woke: false; reason: 'debounced' | 'already-running' | 'disabled' | 'failed' }

// Opt-out via env (default ON). Read lazily so tests/settings can toggle per-call.
function chiefWakeEnabled(): boolean {
  return process.env.CHIEF_WAKE !== '0'
}

// Min-interval debounce window. A module-level `let` so startChiefWake() can override
// it (per-instance timing) while wakeChief() reads the current value.
const DEFAULT_WAKE_MIN_INTERVAL_MS = Number(process.env.CHIEF_WAKE_MIN_INTERVAL_MS) || 5 * 60_000
let minIntervalMs = DEFAULT_WAKE_MIN_INTERVAL_MS

// Timestamp (unix ms) of the last PASS. 0 = never woken (test seam resets to this).
let lastWakeAt = 0

/** Reset the debounce clock — a test/boot seam so a burst is deterministic. */
export function resetChiefWakeDebounce(): void {
  lastWakeAt = 0
}

/**
 * Wake the Chief: activate `startAgentRun('chief', { trigger, goal })` unless a guard
 * blocks it. Never throws — a dispatch failure degrades to {woke:false,reason:'failed'}
 * so the cron/event callback that fired it can't crash. Returns the ledger row + run
 * id on success, or a reason on a skip/failure.
 */
export async function wakeChief(
  trigger: 'schedule' | 'event',
  opts: { goal?: string; thread?: string; now?: number } = {},
): Promise<WakeOutcome> {
  if (!chiefWakeEnabled()) return { woke: false, reason: 'disabled' }

  const now = opts.now ?? Date.now()

  // Guard A — min-interval debounce. A synchronous burst collapses to one wake
  // because lastWakeAt is committed below BEFORE the first await.
  if (now - lastWakeAt < minIntervalMs) return { woke: false, reason: 'debounced' }

  // Guard B — already-running / idempotent. One Chief activation at a time.
  if (agentRunsDb.getRunningAgentRunByProfile.get('chief')) return { woke: false, reason: 'already-running' }

  // PASS. Commit the debounce clock synchronously so a same-tick burst is debounced.
  lastWakeAt = now
  const goal = opts.goal ?? opts.thread ?? DEFAULT_CHIEF_WAKE_GOAL

  try {
    const { agentRunId, runId } = await startAgentRun('chief', { trigger, goal })
    return { woke: true, agentRunId, runId }
  } catch (e) {
    // startAgentRun already recorded the row 'failed' + re-threw (its rollback
    // contract); swallow so the loop never crashes — the ledger shows 'failed'.
    console.warn('[chief-wake] dispatch failed:', e)
    return { woke: false, reason: 'failed' }
  }
}

/**
 * The EventBus run-update handler body, exported so it is unit-testable directly
 * (no cron/async flakiness). On a TERMINAL run that is NOT the Chief's own run,
 * fire-and-forget an 'event'-trigger wake.
 */
export function onChiefWakeRunUpdate(run: Run): void {
  if (!chiefWakeEnabled()) return
  if (!isTerminalRunStatus(run.status)) return

  // Self-wake guard: the Chief's OWN run finishing must not wake the Chief again.
  const owner = agentRunsDb.getAgentRunProfileByRunId.get(run.id) as { profile_id?: string } | undefined
  if (owner?.profile_id === 'chief') return

  void wakeChief('event', { thread: `run ${run.id} → ${run.status}` }).catch(() => {})
}

/**
 * The schedule-tick body, exported so the "a scheduler tick fires
 * startAgentRun('chief', {trigger:'schedule'})" seam is unit-testable DIRECTLY —
 * symmetric with onChiefWakeRunUpdate, side-stepping cron timing flakiness. This is
 * the exact callback the cron task runs. Fire-and-forget; wakeChief never throws.
 */
export function scheduledChiefWake(): void {
  void wakeChief('schedule', { goal: DEFAULT_CHIEF_WAKE_GOAL }).catch(() => { /* never crash the tick */ })
}

/**
 * Start the Chief autonomous wake: register a node-cron schedule tick AND subscribe
 * to terminal run-completion events, both routed through `wakeChief`. Returns a stop
 * fn that tears down the cron task + the subscription (mirrors registerGraphAutoReindex).
 * When disabled (CHIEF_WAKE=0) it wires nothing and returns a no-op stop.
 */
export function startChiefWake(opts?: { cron?: string; minIntervalMs?: number }): () => void {
  if (!chiefWakeEnabled()) return () => { /* disabled — nothing wired */ }

  // minIntervalMs is module-global (wakeChief reads it). Capture the prior value so
  // the stop fn restores it — a per-instance override must not leak past this instance
  // (e.g. into a later startChiefWake() or a standalone wakeChief() call).
  const prevMinInterval = minIntervalMs
  if (opts?.minIntervalMs != null) minIntervalMs = opts.minIntervalMs

  // ── schedule tick ──────────────────────────────────────────────────────────
  const cronExpr = opts?.cron ?? process.env.CHIEF_WAKE_CRON ?? DEFAULT_CHIEF_WAKE_CRON
  let task: ReturnType<typeof cronSchedule> | undefined
  if (cronValidate(cronExpr)) {
    task = cronSchedule(cronExpr, scheduledChiefWake)
  } else {
    console.warn(`[chief-wake] invalid cron expression '${cronExpr}' — scheduled wake disabled`)
  }

  // ── subscribed events ──────────────────────────────────────────────────────
  const off = eventBus.onRunUpdate(onChiefWakeRunUpdate)

  return () => {
    task?.stop()
    off()
    minIntervalMs = prevMinInterval
  }
}
