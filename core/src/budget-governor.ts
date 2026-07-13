// core/src/budget-governor.ts
/**
 * E-17 budget governor — REACTIVE caps on MEASURED spend (runs.cost_usd), rolling
 * 24h window. Zero forecasting: no price×token math, no projection. Org cap lives
 * in autonomy settings; per-project caps on projects.budget_daily_usd. A dispatch
 * is "parked" = refused with a budget_capped reason (no queue); the operator raises
 * the cap to proceed. Always-on: the cap gates even when autonomy is disabled.
 *
 * COVERAGE (kept HONEST — the gate is not universal):
 *   GATED (consult budgetGate before dispatch):
 *     - autonomous/org startAgentRun dispatches — schedule, event, and operator→Chief
 *       delegation triggers (agent-runs.ts);
 *     - autonomous scheduled/event SKILL runs, which reach startRun directly, NOT via
 *       startAgentRun (skills.ts startScheduler + startEventListener — E-17 e17 fix);
 *     - manual dispatch via POST /api/runs (routes/runs.ts → 429).
 *   NOT GATED (deliberate):
 *     - interactive / persistent-session K-secretary turns — the operator must always
 *       be able to reach K to raise the cap;
 *     - operator-initiated action routes (rewind / review-fix / deep-verify / workflows)
 *       and the operator "run skill now" trigger — a TRACKED FOLLOW-UP, not yet gated.
 */
import type { BudgetStatus, BudgetScopeStatus } from '@k/shared'
import { budgetDb, projectsDb } from './db.js'
import { autonomySettings } from './config-store.js'
import { eventBus } from './events.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

export const BUDGET_WINDOW_MS = 24 * 3_600_000

/** Pure state decision. null cap ⇒ ok. capped iff spent >= cap; warn iff spent >= cap*warnPct. */
export function classifyBudget(capUsd: number | null, spentUsd: number, warnPct: number): 'ok' | 'warn' | 'capped' {
  if (capUsd == null) return 'ok'
  if (spentUsd >= capUsd) return 'capped'
  if (spentUsd >= capUsd * warnPct) return 'warn'
  return 'ok'
}

function scopeStatus(capUsd: number | null, spentUsd: number, warnPct: number): BudgetScopeStatus {
  return { capUsd, spentUsd, warnPct, state: classifyBudget(capUsd, spentUsd, warnPct) }
}

/** Full measured status envelope for the org + every project with a cap set. */
export function budgetStatus(now = Date.now()): BudgetStatus {
  const since = now - BUDGET_WINDOW_MS
  const s = autonomySettings()
  const orgSpent = (budgetDb.orgSpendSince.get(since) as { spend: number }).spend
  const projects = (projectsDb.listProjects.all() as Array<{ id: string; name: string; budget_daily_usd: number | null }>)
    .filter(p => p.budget_daily_usd != null)
    .map(p => ({
      projectId: p.id, projectName: p.name,
      status: scopeStatus(p.budget_daily_usd!, (budgetDb.projectSpendSince.get(p.id, since) as { spend: number }).spend, s.budgetWarnPct),
    }))
  return { windowHours: 24, org: scopeStatus(s.orgDailyBudgetUsd, orgSpent, s.budgetWarnPct), projects, generatedAt: now }
}

/** Gate a would-be dispatch. Blocks iff the org OR the dispatch's project is 'capped'. */
export function budgetGate(opts: { projectId?: string | null; now?: number }):
  | { allowed: true }
  | { allowed: false; scope: 'org' | 'project'; capUsd: number; spentUsd: number } {
  const now = opts.now ?? Date.now()
  const since = now - BUDGET_WINDOW_MS
  const s = autonomySettings()
  if (s.orgDailyBudgetUsd != null) {
    const spent = (budgetDb.orgSpendSince.get(since) as { spend: number }).spend
    if (classifyBudget(s.orgDailyBudgetUsd, spent, s.budgetWarnPct) === 'capped') {
      return { allowed: false, scope: 'org', capUsd: s.orgDailyBudgetUsd, spentUsd: spent }
    }
  }
  if (opts.projectId) {
    const p = projectsDb.getProject.get(opts.projectId) as { budget_daily_usd?: number | null } | undefined
    if (p?.budget_daily_usd != null) {
      const spent = (budgetDb.projectSpendSince.get(opts.projectId, since) as { spend: number }).spend
      if (classifyBudget(p.budget_daily_usd, spent, s.budgetWarnPct) === 'capped') {
        return { allowed: false, scope: 'project', capUsd: p.budget_daily_usd, spentUsd: spent }
      }
    }
  }
  return { allowed: true }
}

export class BudgetCapError extends Error {
  constructor(public scope: 'org' | 'project', public capUsd: number, public spentUsd: number) {
    super(`budget_capped: ${scope} cap $${capUsd} reached (measured $${spentUsd.toFixed(2)} in 24h)`)
    this.name = 'BudgetCapError'
  }
}

/**
 * Boot-wired: broadcast the measured budget status once per run TERMINAL — the only
 * moment runs.cost_usd is finalized (supervisor finalizes on success AND error, both
 * routed through emitRunUpdate). Subscribing to the run-update stream but gating on
 * isTerminalRunStatus avoids re-running the SUM/COUNT queries on every interim tick.
 * Returns the unsubscribe teardown (wired next to the other schedulers in index.ts).
 */
export function startBudgetBroadcast(): () => void {
  return eventBus.onRunUpdate(r => {
    if (!isTerminalRunStatus(r.status)) return
    eventBus.broadcast({ type: 'budget_update', status: budgetStatus() })
  })
}
