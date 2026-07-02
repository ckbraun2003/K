import type {
  AgentEvent,
  AgentRun,
  Run,
  AgentProfile,
  ChiefOrgLead,
  OrchestratorRosterEntry,
} from '@k/shared'
import { agentRunsDb, runsDb, eventsDb } from '../db.js'

/**
 * Shared org-assembly primitives (P5.3a) — the row mappers, bounds, live-status set,
 * lead predicate, and per-lead assembly that BOTH the Chief org-status route
 * (routes/chief.ts) and the Orchestrators control-plane route (routes/orchestrators.ts)
 * consume. Factored out of chief.ts behavior-preserving so a lead's assembled shape
 * is derived from exactly one authority (no duplicated latest-run / delegate-events
 * logic that could drift between the two surfaces).
 */

type Row = Record<string, unknown>

// Bounds — one batched read must stay cheap. The tree's events are fetched already
// filtered to delegate pairs (eventsDb.listDelegateEvents), so there is NO arbitrary
// event cap that could silently truncate a long lead run's sub-agent tree. Wake +
// assignment lists are capped; AGENT_RUN_SCAN bounds the per-profile activation scan
// (comfortably above WAKE_CAP so the "latest run with a run_id" find stays in-window).
// No N+1 beyond the per-lead latest-run lookup.
export const WAKE_CAP = 20
export const ASSIGNMENT_LIMIT = 50
export const AGENT_RUN_SCAN = 100

// A lead counts as "active" when its latest run is in a non-terminal state.
export const LIVE_RUN_STATUSES = new Set(['queued', 'running', 'awaiting_input'])

/** Parse a JSON DB column defensively: null/undefined → undefined; malformed →
 *  undefined (a single corrupt row must not 500 the whole payload). Mirrors
 *  routes/runs.ts::safeJsonColumn. */
export function safeJsonColumn(v: unknown): unknown {
  if (v == null) return undefined
  try { return JSON.parse(v as string) } catch { return undefined }
}

/** agent_runs row → the AgentRun wire shape (snake→camel; nullable cols → null). */
export function rowToAgentRun(r: Row): AgentRun {
  return {
    id: String(r.id),
    profileId: String(r.profile_id),
    runId: r.run_id != null ? String(r.run_id) : null,
    trigger: r.trigger as AgentRun['trigger'],
    goal: r.goal != null ? String(r.goal) : null,
    projectId: r.project_id != null ? String(r.project_id) : null,
    workflowId: r.workflow_id != null ? String(r.workflow_id) : null,
    status: r.status as AgentRun['status'],
    createdAt: Number(r.created_at),
    completedAt: r.completed_at != null ? Number(r.completed_at) : null,
  }
}

/** runs row → the Run wire shape (snake→camel; nullable cols → undefined).
 *  Mirrors routes/runs.ts::dbRowToRun, typed to Run for the payload. */
export function rowToRun(r: Row): Run {
  return {
    id: String(r.id),
    prompt: String(r.prompt),
    cwd: String(r.cwd),
    worktree: r.worktree != null ? String(r.worktree) : undefined,
    status: r.status as Run['status'],
    provider: r.provider as Run['provider'],
    model: String(r.model),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    costUsd: Number(r.cost_usd),
    projectId: r.project_id != null ? String(r.project_id) : undefined,
    createdAt: Number(r.created_at),
    endedAt: r.ended_at != null ? Number(r.ended_at) : undefined,
  }
}

/** events row → the AgentEvent wire shape. Mirrors routes/runs.ts::dbRowToEvent
 *  (enriched tool metadata included), so the delegation tree derived on the web
 *  side has the same fields it gets from GET /api/runs/:id/events. */
export function rowToAgentEvent(r: Row): AgentEvent {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    seq: Number(r.seq),
    type: r.type as AgentEvent['type'],
    ts: Number(r.ts),
    ...(r.text != null ? { text: String(r.text) } : {}),
    ...(r.tool != null ? { tool: String(r.tool) } : {}),
    ...(r.tokens_in != null ? { tokensIn: Number(r.tokens_in) } : {}),
    ...(r.tokens_out != null ? { tokensOut: Number(r.tokens_out) } : {}),
    ...(r.cost_usd != null ? { costUsd: Number(r.cost_usd) } : {}),
    ...(r.context_tokens != null ? { contextTokens: Number(r.context_tokens) } : {}),
    ...(r.tool_use_id != null ? { toolUseId: String(r.tool_use_id) } : {}),
    ...(r.tool_kind != null ? { toolKind: r.tool_kind as AgentEvent['toolKind'] } : {}),
    ...(r.tool_input != null ? { toolInput: safeJsonColumn(r.tool_input) } : {}),
    ...(r.tool_result != null ? { toolResult: safeJsonColumn(r.tool_result) } : {}),
    ...(r.tool_result_is_error != null ? { toolResultIsError: r.tool_result_is_error === 1 } : {}),
    ...(r.subagent_type != null ? { subagentType: String(r.subagent_type) } : {}),
    ...(r.child_label != null ? { childLabel: String(r.child_label) } : {}),
  }
}

/** The five discipline leads are orchestrator-tier profiles minus the generic
 *  default-orchestrator (bible §03 — leads are the seeded lead-* rows). */
export function isLead(profile: AgentProfile): boolean {
  return profile.tier === 'orchestrator' && profile.id !== 'default-orchestrator'
}

/** ONE bounded activation scan → the lead's recent activations + its most-recent run
 *  (the newest activation that reached a run_id, resolved to a Run; null if none). The
 *  shared core of both the slim roster view and the full detail assembly, so a lead's
 *  latest-run resolution can never drift between the two. Does NOT fetch delegate
 *  events — that cost is paid only by assembleLead, which actually renders the tree. */
function scanLead(profile: AgentProfile): { runsForLead: Row[]; latestRun: Run | null } {
  const runsForLead = agentRunsDb.listRecentAgentRunsByProfile.all(profile.id, AGENT_RUN_SCAN) as Row[]
  const latestWithRun = runsForLead.find(r => r.run_id != null)
  let latestRun: Run | null = null
  if (latestWithRun) {
    const runRow = runsDb.getRun.get(String(latestWithRun.run_id)) as Row | undefined
    if (runRow) latestRun = rowToRun(runRow)
  }
  return { runsForLead, latestRun }
}

/** The SLIM roster entry for one lead — latest run + live flag + a recent-activation
 *  count (bounded by the scan), WITHOUT the per-lead delegate-events fetch the roster
 *  never renders. Reuses scanLead so `latestRun`/`live` agree with the detail view. */
export function rosterVitals(profile: AgentProfile): OrchestratorRosterEntry {
  const { runsForLead, latestRun } = scanLead(profile)
  const live = latestRun != null && LIVE_RUN_STATUSES.has(latestRun.status)
  return { profile, latestRun, live, wakes: runsForLead.length }
}

/**
 * Assemble one lead's full ChiefOrgLead from ONE bounded activation scan: the lead's
 * recent wakes (bounded), plus its most-recent activation that reached a run (has
 * run_id) → that run + its delegate events (the sub-agent tree source). May be none
 * → latestRun null / events []. Behavior-preserving with the per-lead body the Chief
 * org route ran inline before the P5.3a extraction, so both surfaces derive a lead
 * identically (events are fetched iff a latest run resolved — the original condition).
 */
export function assembleLead(profile: AgentProfile): ChiefOrgLead {
  const { runsForLead, latestRun } = scanLead(profile)
  const wakes = runsForLead.slice(0, WAKE_CAP).map(rowToAgentRun)
  const events: AgentEvent[] = latestRun
    ? (eventsDb.listDelegateEvents.all({ runId: latestRun.id }) as Row[]).map(rowToAgentEvent)
    : []
  return { profile, latestRun, events, wakes }
}
