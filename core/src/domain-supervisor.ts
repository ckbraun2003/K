/**
 * domain-supervisor — always-on, budget-bounded domain oversight (C.4, D-125).
 *
 * chief-wake-shaped: exported testable bodies + start/stop wiring, injected `now`,
 * swallowed callback errors. Inputs: run terminals (eventBus.onRunUpdate, gated on
 * isTerminalRunStatus), pipeline terminals + gate parks (pipeline-engine listener
 * registries), and a cron heartbeat that fires ONLY for domains with active work.
 * Each admitted event → the per-domain GOVERNOR → buildBriefing → ONE
 * agent_messages row addressed to the manager's own conversation. Suppressed wakes
 * write NOTHING (no rows, no ledger).
 *
 * SPEND BOUNDS (SEAMS #2 surface — every layer is a hard bound):
 *   - min-interval debounce (DOMAIN_WAKE_MIN_INTERVAL_MS, default 10 min);
 *     deliberately NOT bypassed by urgent gate events — the heartbeat sweep
 *     re-surfaces open gates within 15 min worst-case. The DB component keys on
 *     the MANAGER (to==from rows), so two domains sharing one manager share one
 *     debounce window + one hourly bucket — spend-TIGHTER than per-domain.
 *   - rolling-hour cap: app_config `domain_wake_max_per_hour` (default 6,
 *     0 = hard off). DB-backed count of prior briefings per manager, restart-safe.
 *   - briefings are FREE rows (no dispatch here); any manager RESPONSE spend rides
 *     startAgentRun's budgetGate when Lane B's relay delivers at INT.
 *   - briefing bodies are hard-capped (BRIEFING_MAX_CHARS).
 * Discriminator: a briefing is the SELF-ADDRESSED manager message
 * (to == from == manager, from_kind 'profile'). C.5's steer forbids self-steering so
 * nothing else can mint rows that match (the cap can't be starved or inflated).
 *
 * Always-on per spec decision #11: NOT gated by the Autonomous Org master.
 * `DOMAIN_SUPERVISOR=0` (env) is the dev/test opt-out; `domain_wake_max_per_hour=0`
 * is the runtime off switch. The DB row IS the interface — deliberately no import
 * of Lane B's agent-mail/message-relay.
 */
import { randomUUID } from 'node:crypto'
import { schedule as cronSchedule, validate as cronValidate } from 'node-cron'
import type { Run } from '@k/shared'
import { eventBus } from './events.js'
import { db, agentMessagesDb, agentRunsDb, configDb } from './db.js'
import { onPipelineTerminal, onGateParked } from './pipeline-engine.js'
import { getOrCreateConversation } from './agent-sessions.js'
import { getDomainById, listAllDomains, domainForProfile } from './domains.js'
import { budgetStatus } from './budget-governor.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

export const DEFAULT_DOMAIN_WAKE_MIN_INTERVAL_MS = 10 * 60_000
export const DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR = 6
export const DEFAULT_DOMAIN_SUPERVISOR_CRON = '*/15 * * * *'
const HOUR_MS = 3_600_000
const BRIEFING_MAX_CHARS = 8_000

export type DomainEventKind =
  | 'run-terminal' | 'pipeline-terminal' | 'gate' | 'failure' | 'budget-warn' | 'heartbeat'
export type BriefOutcome =
  | { briefed: true; messageId: string }
  | { briefed: false; reason: 'no-domain' | 'no-manager' | 'debounced' | 'rate-capped' | 'no-active-work' | 'failed' }

let minIntervalMs = Number(process.env.DOMAIN_WAKE_MIN_INTERVAL_MS) || DEFAULT_DOMAIN_WAKE_MIN_INTERVAL_MS
const lastBriefedAt = new Map<string, number>()
let lastOrgBudgetState: 'ok' | 'warn' | 'capped' = 'ok'

/** Test seam: clear the in-memory debounce + budget-edge state. */
export function resetDomainSupervisorState(): void {
  lastBriefedAt.clear()
  lastOrgBudgetState = 'ok'
}

function wakeMaxPerHour(): number {
  const raw = configDb.get('domain_wake_max_per_hour')
  if (raw == null) return DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR
}

// ── local statements (private-statement precedent) ────────────────────────────

const countRecentBriefingsRow = db.prepare(`
  SELECT COUNT(*) AS n FROM agent_messages
  WHERE to_profile_id = ? AND from_profile_id = ? AND from_kind = 'profile' AND created_at >= ?
`)
const lastBriefingTsRow = db.prepare(`
  SELECT MAX(created_at) AS ts FROM agent_messages
  WHERE to_profile_id = ? AND from_profile_id = ? AND from_kind = 'profile'
`)
const activePipelinesRow = db.prepare(
  `SELECT COUNT(*) AS n FROM pipeline_runs WHERE domain_id = ? AND status = 'running'`,
)
const activeAgentRunsRow = db.prepare(`
  SELECT COUNT(*) AS n FROM agent_runs ar JOIN agent_profiles p ON p.id = ar.profile_id
  WHERE p.domain_id = ? AND ar.status = 'running'
`)
const pipelineRunDomainRow = db.prepare(`SELECT domain_id FROM pipeline_runs WHERE id = ?`)
const openGatesRows = db.prepare(`
  SELECT s.id, s.stage_key, s.created_at, pr.title FROM pipeline_stages s
  JOIN pipeline_runs pr ON pr.id = s.pipeline_run_id
  WHERE pr.domain_id = ? AND s.status = 'awaiting_gate'
  ORDER BY s.created_at ASC, s.id ASC LIMIT 20
`)
// ASC LIMIT 50 is a deliberate choice: the delta reads as a chronological
// narrative from where the last briefing left off; on overflow the OLDEST
// unreported entries win and the next admitted wake (sinceTs advanced) carries
// the rest. Bounded either way.
const ledgerDeltaRows = db.prepare(`
  SELECT l.stage_key, l.ts, l.kind, l.actor, l.goal, pr.title FROM pipeline_ledger l
  JOIN pipeline_runs pr ON pr.id = l.pipeline_run_id
  WHERE pr.domain_id = ? AND l.ts > ? ORDER BY l.ts ASC, l.seq ASC LIMIT 50
`)
const failedStagesRows = db.prepare(`
  SELECT s.stage_key, s.failure_class, s.completed_at, pr.title FROM pipeline_stages s
  JOIN pipeline_runs pr ON pr.id = s.pipeline_run_id
  WHERE pr.domain_id = ? AND s.status = 'failed' AND s.completed_at > ?
  ORDER BY s.completed_at DESC LIMIT 10
`)
const failedAgentRunsRows = db.prepare(`
  SELECT ar.run_id, ar.goal, ar.completed_at, p.name FROM agent_runs ar
  JOIN agent_profiles p ON p.id = ar.profile_id
  WHERE p.domain_id = ? AND ar.status = 'failed' AND ar.completed_at > ?
  ORDER BY ar.completed_at DESC LIMIT 10
`)

// ── briefing ──────────────────────────────────────────────────────────────────

export function domainHasActiveWork(domainId: string): boolean {
  return Number((activePipelinesRow.get(domainId) as { n: number }).n) > 0
    || Number((activeAgentRunsRow.get(domainId) as { n: number }).n) > 0
}

/** Assemble the capped briefing body: progress-ledger delta since `sinceTs`, open
 *  gates (with the stage ids resolve_gate takes), recent failures, budget state. */
export function buildBriefing(domainId: string, sinceTs: number, now = Date.now()): string {
  const lines: string[] = []
  const ledger = ledgerDeltaRows.all(domainId, sinceTs) as Array<Record<string, unknown>>
  lines.push(`## Progress since ${new Date(sinceTs).toISOString()}`)
  if (ledger.length === 0) lines.push('(no ledger activity)')
  for (const e of ledger) {
    lines.push(`- [${e.kind}] ${e.title}${e.stage_key ? ` · ${e.stage_key}` : ''}: ${e.goal ?? ''}`.trimEnd())
  }
  const gates = openGatesRows.all(domainId) as Array<Record<string, unknown>>
  lines.push('', `## Open gates (${gates.length})`)
  if (gates.length === 0) lines.push('(none)')
  for (const g of gates) {
    lines.push(`- ${g.title} · ${g.stage_key} — gateId ${g.id} (resolve with resolve_gate)`)
  }
  const failedStages = failedStagesRows.all(domainId, sinceTs) as Array<Record<string, unknown>>
  const failedRuns = failedAgentRunsRows.all(domainId, sinceTs) as Array<Record<string, unknown>>
  lines.push('', `## Failures since last briefing (${failedStages.length + failedRuns.length})`)
  if (failedStages.length + failedRuns.length === 0) lines.push('(none)')
  for (const f of failedStages) lines.push(`- stage ${f.stage_key} of ${f.title} failed (${f.failure_class ?? 'unclassified'})`)
  for (const f of failedRuns) lines.push(`- ${f.name} run ${f.run_id ?? '?'} failed: ${String(f.goal ?? '').slice(0, 120)}`)
  const budget = budgetStatus(now)
  lines.push('', '## Budget',
    `- org: ${budget.org.state} (spent $${budget.org.spentUsd.toFixed(4)}${budget.org.capUsd != null ? ` of $${budget.org.capUsd}` : ', no cap'})`)
  for (const p of budget.projects) {
    if (p.status.state !== 'ok') lines.push(`- project ${p.projectName}: ${p.status.state}`)
  }
  const body = lines.join('\n')
  return body.length > BRIEFING_MAX_CHARS ? `${body.slice(0, BRIEFING_MAX_CHARS)}\n…(truncated)` : body
}

/** The governed wake: resolve domain + manager → gates (active-work for heartbeats,
 *  debounce, rolling-hour cap — suppression writes NOTHING) → briefing row addressed
 *  to the manager's conversation. Never throws — the WHOLE body is guarded, so a
 *  transient DB error in a governor read can never escape into a cron callback or
 *  event-bus emit loop. */
export function briefDomain(
  domainId: string,
  evt: { kind: DomainEventKind; detail?: string; urgent?: boolean },
  now = Date.now(),
): BriefOutcome {
  try {
    const domain = getDomainById(domainId)
    if (!domain) return { briefed: false, reason: 'no-domain' }
    const manager = domain.managerProfileId
    if (!manager) return { briefed: false, reason: 'no-manager' }
    if (evt.kind === 'heartbeat' && !domainHasActiveWork(domainId)) {
      return { briefed: false, reason: 'no-active-work' }
    }
    const dbLast = Number((lastBriefingTsRow.get(manager, manager) as { ts: number | null }).ts ?? 0)
    const last = Math.max(lastBriefedAt.get(domainId) ?? 0, dbLast)
    if (now - last < minIntervalMs) return { briefed: false, reason: 'debounced' }
    const recent = Number((countRecentBriefingsRow.get(manager, manager, now - HOUR_MS) as { n: number }).n)
    if (recent >= wakeMaxPerHour()) return { briefed: false, reason: 'rate-capped' }
    lastBriefedAt.set(domainId, now) // commit synchronously (chief-wake burst posture)
    const sinceTs = last > 0 ? last : now - HOUR_MS
    const header = `[domain briefing · ${domain.name} · ${evt.kind}]${evt.detail ? `\n${evt.detail}` : ''}`
    const body = `${header}\n\n${buildBriefing(domainId, sinceTs, now)}`
    const thread = getOrCreateConversation(manager)
    const id = randomUUID()
    agentMessagesDb.insert.run({
      id, toProfileId: manager, toThreadId: thread.id, fromKind: 'profile',
      fromProfileId: manager, body, priority: evt.urgent ? 'urgent' : 'normal',
      provenanceRunId: null, createdAt: now,
    })
    return { briefed: true, messageId: id }
  } catch (e) {
    console.error('[domain-supervisor] briefing failed:', e)
    return { briefed: false, reason: 'failed' }
  }
}

// ── event handlers (all swallow — chief-wake posture) ─────────────────────────

export function onSupervisorRunUpdate(run: Run): void {
  try {
    if (!isTerminalRunStatus(run.status)) return
    const owner = agentRunsDb.getAgentRunProfileByRunId.get(run.id) as
      | { profile_id?: string } | undefined
    if (!owner?.profile_id) return // not an org run
    const domain = domainForProfile(owner.profile_id)
    if (!domain) return // unattributed profile (e.g. K)
    // Self-guard: a manager's own run (incl. its reaction to a briefing) must not
    // re-brief the manager — the chief-wake self-wake precedent.
    if (domain.managerProfileId === owner.profile_id) return
    // Run's terminal statuses are done|error|killed|interrupted (no 'failed') —
    // any non-'done' terminal is a failure (the deriveAgentRunStatus mapping).
    const failed = run.status !== 'done'
    // Budget EDGE detection (hysteresis): a state flip is folded into THIS
    // briefing — a separate follow-up briefDomain call could never land (the row
    // just written would debounce it; quality-review m1). A rising edge that gets
    // suppressed stays PENDING (state not consumed) so the next admitted wake
    // still carries the warning; a falling edge (back to ok) is consumed silently.
    const st = budgetStatus().org.state
    const rising = st !== lastOrgBudgetState && st !== 'ok'
    let detail = `run ${run.id} → ${run.status}`
    if (rising) detail += `\norg budget state → ${st}`
    const out = briefDomain(domain.id, {
      kind: failed ? 'failure' : rising ? 'budget-warn' : 'run-terminal',
      detail,
    })
    if (!rising || out.briefed) lastOrgBudgetState = st
  } catch { /* swallowed */ }
}

export function onSupervisorPipelineTerminal(pipelineRunId: string, status: 'completed' | 'failed'): void {
  try {
    const row = pipelineRunDomainRow.get(pipelineRunId) as { domain_id?: string | null } | undefined
    if (row?.domain_id == null) return
    briefDomain(String(row.domain_id), {
      kind: status === 'failed' ? 'failure' : 'pipeline-terminal',
      detail: `pipeline ${pipelineRunId} → ${status}`,
    })
  } catch { /* swallowed */ }
}

export function onSupervisorGateParked(pipelineRunId: string, stageId: string): void {
  try {
    const row = pipelineRunDomainRow.get(pipelineRunId) as { domain_id?: string | null } | undefined
    if (row?.domain_id == null) return
    briefDomain(String(row.domain_id), {
      kind: 'gate', detail: `stage ${stageId} awaiting approval`, urgent: true,
    })
  } catch { /* swallowed */ }
}

/** Cron body: every managed domain rides the SAME governor (active-work gate inside
 *  briefDomain). Exported for direct-drive tests. Guarded so a transient DB error
 *  (e.g. listAllDomains) can never escape into the raw cron callback — the
 *  scheduledChiefWake posture. */
export function heartbeatTick(now = Date.now()): void {
  try {
    for (const domain of listAllDomains()) {
      if (!domain.managerProfileId) continue
      briefDomain(domain.id, { kind: 'heartbeat' }, now)
    }
  } catch (e) {
    console.warn('[domain-supervisor] heartbeat tick failed:', e)
  }
}

export function startDomainSupervisor(opts?: { cron?: string; minIntervalMs?: number }): () => void {
  if (process.env.DOMAIN_SUPERVISOR === '0') return () => {}
  const prevMinInterval = minIntervalMs
  if (opts?.minIntervalMs !== undefined) minIntervalMs = opts.minIntervalMs
  const offRun = eventBus.onRunUpdate(onSupervisorRunUpdate)
  const offPipe = onPipelineTerminal(onSupervisorPipelineTerminal)
  const offGate = onGateParked(onSupervisorGateParked)
  const cronExpr = opts?.cron ?? process.env.DOMAIN_SUPERVISOR_CRON ?? DEFAULT_DOMAIN_SUPERVISOR_CRON
  let task: ReturnType<typeof cronSchedule> | undefined
  if (cronValidate(cronExpr)) task = cronSchedule(cronExpr, () => heartbeatTick())
  else console.warn(`[domain-supervisor] invalid cron expression '${cronExpr}' — heartbeat disabled`)
  return () => {
    task?.stop()
    offGate(); offPipe(); offRun()
    minIntervalMs = prevMinInterval
  }
}
