import type { FastifyInstance } from 'fastify'
import type { AgentEvent, AgentRun, Run, ChiefOrgLead, ChiefOrgPayload } from '@k/shared'
import { getProfile, listProfiles } from '../profiles.js'
import { agentRunsDb, runsDb, eventsDb, mgmtDb } from '../db.js'
import { rowToAssignment } from '../mcp/mgmt.js'

/**
 * Chief org-status route (P5.2a) — the read half of the Chief surface.
 *
 * GET /api/chief/org assembles the WHOLE org-status page in ONE batched payload so
 * the page issues a single query (no per-lead useQuery fan-out): the Chief profile,
 * each discipline lead with its most-recent run + that run's events (the source the
 * delegation tree is derived from) + its wake history, the Chief's own wakes, the
 * recent assignments (Objectives), and a THIN health summary (D-026 — no full health
 * strip re-computed here). Autonomous wake + delegation dispatch are out of scope
 * (P5.2b); this route only READS.
 */

type Row = Record<string, unknown>

// Bounds — one batched read must stay cheap. The tree's events are fetched already
// filtered to delegate pairs (eventsDb.listDelegateEvents), so there is NO arbitrary
// event cap that could silently truncate a long lead run's sub-agent tree. Wake +
// assignment lists are capped; AGENT_RUN_SCAN bounds the per-profile activation scan
// (comfortably above WAKE_CAP so the "latest run with a run_id" find stays in-window).
// No N+1 beyond the per-lead latest-run lookup.
const WAKE_CAP = 20
const ASSIGNMENT_LIMIT = 50
const AGENT_RUN_SCAN = 100

// A lead counts as "active" when its latest run is in a non-terminal state.
const LIVE_RUN_STATUSES = new Set(['queued', 'running', 'awaiting_input'])

/** Parse a JSON DB column defensively: null/undefined → undefined; malformed →
 *  undefined (a single corrupt row must not 500 the whole payload). Mirrors
 *  routes/runs.ts::safeJsonColumn. */
function safeJsonColumn(v: unknown): unknown {
  if (v == null) return undefined
  try { return JSON.parse(v as string) } catch { return undefined }
}

/** agent_runs row → the AgentRun wire shape (snake→camel; nullable cols → null). */
function rowToAgentRun(r: Row): AgentRun {
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
function rowToRun(r: Row): Run {
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
function rowToAgentEvent(r: Row): AgentEvent {
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

export async function chiefRoutes(app: FastifyInstance) {
  // GET /api/chief/org — the one batched org-status payload.
  app.get('/api/chief/org', async (_req, reply) => {
    const chief = getProfile('chief')

    // The five discipline leads: orchestrator-tier profiles minus the generic
    // default-orchestrator (bible §03 — leads are the seeded lead-* rows).
    const leadProfiles = listProfiles().filter(
      p => p.tier === 'orchestrator' && p.id !== 'default-orchestrator',
    )

    const leads: ChiefOrgLead[] = leadProfiles.map(profile => {
      const runsForLead = agentRunsDb.listRecentAgentRunsByProfile.all(profile.id, AGENT_RUN_SCAN) as Row[]
      const wakes = runsForLead.slice(0, WAKE_CAP).map(rowToAgentRun)
      // The lead's most recent activation that actually reached a run (has run_id)
      // → that run + its delegate events (the tree source). May be none → null / [].
      const latestWithRun = runsForLead.find(r => r.run_id != null)
      let latestRun: Run | null = null
      let events: AgentEvent[] = []
      if (latestWithRun) {
        const runRow = runsDb.getRun.get(String(latestWithRun.run_id)) as Row | undefined
        if (runRow) {
          latestRun = rowToRun(runRow)
          events = (eventsDb.listDelegateEvents.all({ runId: latestRun.id }) as Row[]).map(rowToAgentEvent)
        }
      }
      return { profile, latestRun, events, wakes }
    })

    const chiefWakes = (agentRunsDb.listRecentAgentRunsByProfile.all('chief', AGENT_RUN_SCAN) as Row[])
      .slice(0, WAKE_CAP)
      .map(rowToAgentRun)

    const assignments = (mgmtDb.listRecentAssignments.all(ASSIGNMENT_LIMIT) as Row[]).map(rowToAssignment)

    // THIN health only (D-026): the cheap leads-active count, nothing more.
    const leadsActive = leads.filter(
      l => l.latestRun != null && LIVE_RUN_STATUSES.has(l.latestRun.status),
    ).length

    const payload: ChiefOrgPayload = {
      chief,
      leads,
      chiefWakes,
      assignments,
      health: { leadsActive },
    }
    return reply.send(payload)
  })
}
