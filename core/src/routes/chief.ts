import type { FastifyInstance } from 'fastify'
import type { AgentRun, ChiefOrgLead, ChiefOrgPayload } from '@k/shared'
import { getProfile, listProfiles } from '../profiles.js'
import { agentRunsDb, mgmtDb } from '../db.js'
import { rowToAssignment } from '../mcp/mgmt.js'
import {
  AGENT_RUN_SCAN,
  ASSIGNMENT_LIMIT,
  WAKE_CAP,
  LIVE_RUN_STATUSES,
  assembleLead,
  isLead,
  rowToAgentRun,
} from './org-shared.js'

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
 *
 * The per-lead assembly + row mappers + bounds now live in routes/org-shared.ts so the
 * Orchestrators control-plane route (P5.3a) derives a lead identically (behavior-
 * preserving extraction — this route's payload is unchanged).
 */

type Row = Record<string, unknown>

export async function chiefRoutes(app: FastifyInstance) {
  // GET /api/chief/org — the one batched org-status payload.
  app.get('/api/chief/org', async (_req, reply) => {
    const chief = getProfile('chief')

    // The five discipline leads: orchestrator-tier profiles minus the generic
    // default-orchestrator (bible §03 — leads are the seeded lead-* rows).
    const leadProfiles = listProfiles().filter(isLead)

    const leads: ChiefOrgLead[] = leadProfiles.map(assembleLead)

    const chiefWakes: AgentRun[] = (agentRunsDb.listRecentAgentRunsByProfile.all('chief', AGENT_RUN_SCAN) as Row[])
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
