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
 * ── The guard set (every wake is a REAL PAID Claude activation) ──────────────────
 *  • Guard A (min-interval debounce): a burst of ticks/events collapses to one wake —
 *    `lastWakeAt` is set SYNCHRONOUSLY before the await so a synchronous burst is
 *    debounced deterministically.
 *  • Guard B (already-running / idempotent): if a chief run is already 'running',
 *    a new wake is skipped — one Chief activation at a time.
 *  • Self-wake guard (`onChiefWakeRunUpdate`): the Chief's OWN run finishing must NOT
 *    wake the Chief again, or a wake→run→complete→wake loop forms.
 *  • Org-relevance filter (`onChiefWakeRunUpdate`, event path only): a terminal run
 *    wakes the Chief ONLY if its agent_runs row is orchestrator-tier (a lead) or was
 *    triggered by a delegation. Chat-turn runs (run.kind, D-127) are structurally
 *    excluded first — conversation traffic (K asks, agent-session turns) is never an
 *    org event — and plain runs (no agent_runs row: evals, skills, manual runs) fail
 *    both relevance arms. The Chief reacts to ORG events, not to every run.
 *  • Rate breaker (`wakeChief`, event trigger only): at most `chief_wake_max_per_hour`
 *    (app_config, default 6) event wakes per rolling hour — {reason:'rate-capped'},
 *    NO ledger row. A chief-dispatched lead's terminal legitimately re-wakes the Chief
 *    (that IS the autonomous loop), so this breaker is the hard cost bound on the
 *    wake→dispatch_lead→lead-terminal→wake cycle. Cron/schedule wakes are exempt.
 *  • Kill switch (`onChiefWakeRunUpdate`): app_config `chief_wake_events_enabled`
 *    (default '1'); '0' disables the EVENT path entirely, cron wakes unaffected.
 *    Read lazily per event so the operator can flip it at runtime.
 *  • Failure-degrade: `startAgentRun` records the row 'failed' + re-throws on a dispatch
 *    failure; `wakeChief` SWALLOWS that (returns {woke:false,reason:'failed'}) so the
 *    cron/event callback never crashes the loop — while the ledger still shows 'failed'.
 */

import { schedule as cronSchedule, validate as cronValidate } from 'node-cron'
import type { Run } from '@k/shared'
import { eventBus } from './events.js'
import { startAgentRun } from './agent-runs.js'
import { agentRunsDb, configDb } from './db.js'
import { getProfile } from './profiles.js'
import { autonomySettings, claudeDefaultModel } from './config-store.js'
import { warnIfOrgRoleModelNotToolCapable } from './agent-config.js'
import { isTerminalRunStatus } from './run-lifecycle.js'
import { runCollectors } from './proposal-collectors.js'

/** The Chief's default schedule-wake instruction (the `-p` seed for a cron wake). Names the
 *  dispatchable leads inline (F-067) so an autonomously-woken Chief always knows the VALID
 *  lead identifiers and never invents a discipline like "engineering"; `lead_list` remains the
 *  authoritative runtime roster. The lead set is fixed by the durable seed (profiles.ts), so a
 *  static enumeration is safe and keeps this a plain constant.
 *
 *  E-14 "optional prioritization pass": a goal-text-only addition (no new code path) pointing
 *  the woken Chief at the open (blocked, sourced) proposal backlog via the existing kstore
 *  work-item tools — it may PRUNE stale ones (work_item_update → status 'cancelled'); it never
 *  reorders (no priority column — YAGNI) and never approves (approval stays an operator action
 *  via the Inbox). */
export const DEFAULT_CHIEF_WAKE_GOAL =
  'Autonomous org check-in: review active leads and open objectives with the mgmt read tools ' +
  '(assignment_list, report_list); surface blockers and note any unstaffed work. Report a concise ' +
  'status; do not dispatch new work yet. The dispatchable leads are Frontend (lead-frontend), ' +
  'Backend (lead-backend), Systems (lead-systems), Security (lead-security), and Network ' +
  '(lead-network) — call lead_list for the authoritative roster before assign_lead / dispatch_lead. ' +
  'If there are open proposals (work_item_list scope=org status=blocked), review them and cancel ' +
  '(work_item_update status=cancelled) any that are stale or no longer relevant — leave the rest ' +
  'for operator approval; do not approve proposals yourself.'

/** Default cron for the Chief's scheduled wake (every 15 minutes). A literal default;
 *  the `CHIEF_WAKE_CRON` env override is read lazily inside startChiefWake() so it can
 *  be set after import (mirroring the lazy chiefWakeEnabled() read). */
export const DEFAULT_CHIEF_WAKE_CRON = '*/15 * * * *'

/** The outcome of a wake attempt. A success carries the ledger row id + the run id;
 *  a skip/failure carries a machine-readable reason. */
export type WakeOutcome =
  | { woke: true; agentRunId: string; runId: string }
  | { woke: false; reason: 'debounced' | 'already-running' | 'disabled' | 'rate-capped' | 'failed' }

// The autonomous org master switch — persisted, operator-configured (Settings →
// Autonomous Org), DEFAULT OFF. Replaces the old env-gated default (CHIEF_WAKE).
function chiefWakeEnabled(): boolean {
  return autonomySettings().enabled === true
}

/** One-time boot warning: the CHIEF_WAKE env var is deprecated; the persisted
 *  Settings toggle is authoritative. Call once from startChiefWake. */
let deprecationWarned = false
function warnDeprecatedChiefWakeEnv(): void {
  if (deprecationWarned) return
  if (process.env.CHIEF_WAKE !== undefined) {
    deprecationWarned = true
    console.warn('[chief-wake] CHIEF_WAKE env is deprecated and ignored — set autonomy via Settings → Autonomous Org (persisted, default OFF).')
  }
}

// ── Rate breaker (event wakes only) ─────────────────────────────────────────

/** Fallback cap when `chief_wake_max_per_hour` is unset or garbled. */
const DEFAULT_WAKE_MAX_PER_HOUR = 6

const HOUR_MS = 3_600_000

/** Max event-trigger wakes per rolling hour — app_config `chief_wake_max_per_hour`,
 *  read lazily per wake so the operator can tune it at runtime. Invalid/negative
 *  values fall back to the default; 0 is a VALID "block all event wakes". */
function wakeMaxPerHour(): number {
  const raw = configDb.get('chief_wake_max_per_hour')
  if (raw == null) return DEFAULT_WAKE_MAX_PER_HOUR
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WAKE_MAX_PER_HOUR
}

// warn-once-per-suppression-streak latch: the breaker can suppress many wakes in a
// busy hour — log the FIRST suppression of a streak, then stay quiet until an event
// wake passes the breaker again (which resets the latch).
let rateCapWarned = false

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

/** Single-line preview of a wake goal for the observability log (F-089): collapse
 *  whitespace and cap length so a long default instruction stays one readable line. */
function goalPreview(goal: string, max = 80): string {
  const oneLine = goal.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
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

  // Rate breaker — EVENT wakes only (cron/schedule wakes are exempt): count the
  // Chief's event activations in the rolling hour against the operator cap. A capped
  // wake skips BEFORE startAgentRun, so no agent_runs row is ever created for it,
  // and BEFORE lastWakeAt commits, so it never consumes the debounce window either.
  if (trigger === 'event') {
    const cap = wakeMaxPerHour()
    const { n } = agentRunsDb.countRecentAgentRunsByProfileAndTrigger.get('chief', 'event', now - HOUR_MS) as { n: number }
    if (n >= cap) {
      if (!rateCapWarned) {
        rateCapWarned = true
        console.warn(`[chief-wake] event wakes rate-capped: ${n} in the last hour >= cap ${cap} (chief_wake_max_per_hour)`)
      }
      return { woke: false, reason: 'rate-capped' }
    }
    rateCapWarned = false // an event wake passed the breaker — end the suppression streak
  }

  // PASS. Commit the debounce clock synchronously so a same-tick burst is debounced.
  lastWakeAt = now
  const goal = opts.goal ?? opts.thread ?? DEFAULT_CHIEF_WAKE_GOAL

  // WARN-ONLY (org-role model capability): a Chief resolved to a haiku-tier model can't
  // reliably drive the DEFERRED management tools (assign_lead/dispatch_lead/…), so the
  // autonomous chain silently stalls (live-observed). Surface it once per wake at the
  // Chief-dispatch choke-point; do NOT change the dispatch — the configured model still
  // runs with the same tokens/tool grants. Model resolution MIRRORS startAgentRun's
  // precedence (no per-wake override → the chief profile default → the runtime Claude
  // default resolved at dispatch time).
  warnIfOrgRoleModelNotToolCapable('Chief', getProfile('chief')?.defaultModel ?? claudeDefaultModel())

  try {
    const { agentRunId, runId } = await startAgentRun('chief', { trigger, goal })
    // F-089: a wake previously left only DB rows as evidence. Emit ONE routine line at
    // the successful PASS so an operator can see, in the core log, that the Chief woke —
    // the trigger, the seeding goal (truncated), and the resulting run + ledger ids.
    console.log(
      `[chief-wake] woke chief (trigger=${trigger}, run=${runId}, agentRun=${agentRunId}) goal="${goalPreview(goal)}"`,
    )
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
 * (no cron/async flakiness). On a TERMINAL run that is ORG-RELEVANT — a lead
 * (orchestrator-tier) activation or a delegation-triggered one, and never the
 * Chief's own run — fire-and-forget an 'event'-trigger wake. Gated by the
 * `chief_wake_events_enabled` kill switch (event path only; cron unaffected).
 */
export function onChiefWakeRunUpdate(run: Run): void {
  if (!chiefWakeEnabled()) return
  if (!isTerminalRunStatus(run.status)) return

  // D-127: chat turns are conversation traffic, never org events — structurally
  // excluded by KIND before any owner-row inspection. This generalizes the old
  // K-chat special case (K asks and agent-session turns are chat-turn runs).
  if (run.kind === 'chat-turn') return

  // Kill switch — read lazily per event so the operator can flip it at runtime.
  if ((configDb.get('chief_wake_events_enabled') ?? '1') === '0') return

  // Org-relevance filter. A run with NO agent_runs row (evals, skills, manual runs)
  // is not an org event — no wake.
  const owner = agentRunsDb.getAgentRunProfileByRunId.get(run.id) as
    | { profile_id?: string; trigger?: string }
    | undefined
  if (!owner?.profile_id) return
  // Self-wake guard (before the relevance arms): the Chief's OWN run finishing must
  // not wake the Chief again, or a wake→run→complete→wake loop forms.
  if (owner.profile_id === 'chief') return
  // Org-relevant = a delegation-triggered run OR a lead (orchestrator-tier profile).
  // Chat-turn terminals never reach these arms — the D-127 kind exclusion above
  // fires first; legacy kind-less K-chat rows still fail both arms here.
  const orgRelevant =
    owner.trigger === 'delegation' || getProfile(owner.profile_id)?.tier === 'orchestrator'
  if (!orgRelevant) return

  void wakeChief('event', { thread: `run ${run.id} → ${run.status}` }).catch(() => {})
}

/**
 * The schedule-tick body, exported so the "a scheduler tick fires
 * startAgentRun('chief', {trigger:'schedule'})" seam is unit-testable DIRECTLY —
 * symmetric with onChiefWakeRunUpdate, side-stepping cron timing flakiness. This is
 * the exact callback the cron task runs. Fire-and-forget; wakeChief never throws.
 */
export function scheduledChiefWake(): void {
  try { runCollectors() } catch (e) { console.warn('[chief-wake] collectors failed:', e) }
  void wakeChief('schedule', { goal: DEFAULT_CHIEF_WAKE_GOAL }).catch(() => { /* never crash the tick */ })
}

/**
 * Start the Chief autonomous wake: register a node-cron schedule tick AND subscribe
 * to terminal run-completion events, both routed through `wakeChief`. Returns a stop
 * fn that tears down the cron task + the subscription (mirrors registerGraphAutoReindex).
 * ALWAYS wires (M3): while autonomySettings().enabled is false (the default) each tick /
 * event is gated to a cheap no-op by wakeChief()/onChiefWakeRunUpdate(), and enabling
 * Autonomous Org at runtime goes live on the NEXT tick/event with no process restart.
 */
export function startChiefWake(opts?: { cron?: string; minIntervalMs?: number }): () => void {
  // MINOR-1: fire the one-time CHIEF_WAKE env-deprecation warning at boot REGARDLESS of the
  // enabled state — hoisted above every gate. It previously sat after a disabled early-return,
  // so a default-OFF operator who still set CHIEF_WAKE=1 never saw the deprecation notice.
  warnDeprecatedChiefWakeEnv()

  // M3: ALWAYS wire the cron tick + the run-update subscription — do NOT early-return when
  // autonomy is OFF. wakeChief(), onChiefWakeRunUpdate(), and runCollectors() each RE-READ the
  // persisted autonomySettings().enabled per tick/event, so while disabled a tick is a cheap
  // no-op and the subscription callback returns early — and the moment the operator flips
  // Autonomous Org ON in Settings, the NEXT scheduled tick / run-completion event wakes the
  // Chief with NO process restart (mirrors startProposalCollectors' always-schedule +
  // per-tick-gate design). The rate breaker + kill switch (in wakeChief / onChiefWakeRunUpdate)
  // stay fully intact — this only removes the boot-time all-or-nothing gate.

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
