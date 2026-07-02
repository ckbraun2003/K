import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentProfile, AgentRun, Assignment, ChiefOrgLead, ChiefOrgPayload } from '@k/shared'
import { getProfile, listProfiles } from '../profiles.js'
import { db, agentRunsDb, mgmtDb, runsDb, leadDispatchDb } from '../db.js'
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
 * Chief org routes (P5.2a read + C2 reassign actuation).
 *
 * GET /api/chief/org assembles the WHOLE org-status page in ONE batched payload so
 * the page issues a single query (no per-lead useQuery fan-out): the Chief profile,
 * each discipline lead with its most-recent run + that run's events (the source the
 * delegation tree is derived from) + its wake history, the Chief's own wakes, the
 * recent assignments (Objectives), and a THIN health summary (D-026 — no full health
 * strip re-computed here).
 *
 * PATCH /api/chief/assignments/:id is the one operator WRITE here: reassign an
 * objective's lead. Guarded conservatively — a live lead run or a queued dispatch
 * intent blocks the reassign (409) rather than yanking work out from under a lead.
 *
 * The per-lead assembly + row mappers + bounds live in routes/org-shared.ts so the
 * Orchestrators control-plane route (P5.3a) derives a lead identically.
 */

/** The reassign body — exactly one field, strict so a typo can't silently no-op. */
const ReassignBodySchema = z.object({ leadProfileId: z.string().min(1) }).strict()

type Row = Record<string, unknown>

/** Thrown inside the reassign transaction for guard failures — carries the HTTP
 *  status so the route maps it without string-matching. Any other throw inside the
 *  tx re-throws unmapped → Fastify 500 (a server fault, never mislabelled 4xx). */
class ReassignError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'ReassignError'
  }
}

// ONE IMMEDIATE transaction for the reassign's read→guards→update→audit sequence:
// mgmt_assignments is concurrently written by the per-Chief-run stdio MCP CHILDREN
// (mcp/mgmt.ts wraps pick_workflow/scope_projects in exactly this idiom for exactly
// this table) — without the tx an interleaved child write between this route's read
// and its UPDATE (which rewrites workflow/projects/note from the read) would be
// silently overwritten. `.immediate()` takes the write lock up front (see mgmt.ts's
// SQLITE_BUSY_SNAPSHOT note). Guard failures THROW the typed ReassignError, rolling
// back with nothing written.
const reassignTx = db.transaction((assignmentId: string, profile: AgentProfile): Assignment => {
  const row = mgmtDb.getAssignment.get(assignmentId) as Row | undefined
  if (!row) throw new ReassignError(404, 'not found')
  const assignment = rowToAssignment(row)

  // Guard 1: the currently dispatched lead run is still live — reassigning now
  // would strand a running lead on an objective it no longer owns. Stop the run
  // first (the Chief page offers exactly that action), then reassign.
  if (assignment.leadRunId != null) {
    const run = runsDb.getRun.get(assignment.leadRunId) as { status?: string } | undefined
    if (run?.status != null && LIVE_RUN_STATUSES.has(run.status)) {
      throw new ReassignError(409, 'lead run is live')
    }
  }

  // Guard 2: an IN-FLIGHT lead_dispatches intent for this assignment — the
  // main-process relay would execute (or is executing) that intent under the OLD
  // lead, silently undoing the reassign the operator just confirmed. "In flight" is
  // liveness-DERIVED (pending, or dispatched with a live/unrecorded run); a COMPLETED
  // intent is retired-by-derivation and does not block — see
  // db.ts::getActiveLeadDispatchByAssignment.
  if (leadDispatchDb.getActiveLeadDispatchByAssignment.get(assignmentId)) {
    throw new ReassignError(409, 'assignment has a pending dispatch')
  }

  // Guard 3: a same-lead "reassign" is a no-op — reject it rather than filing an
  // "X → X" audit report. The UI dirty-check already prevents this; the guard is
  // for direct API callers.
  if (assignment.lead === profile.name) throw new ReassignError(400, 'lead unchanged')

  // Apply: store the profile NAME (not the id) as the assignment's lead —
  // resolveLeadProfileId (chief-dispatch.ts) resolves an exact profile name, so a
  // future dispatch_lead still resolves; and the name renders correctly in the UI
  // lead chip. Objective/note/workflow/projects are kept verbatim.
  const oldLead = assignment.lead
  const now = Date.now()
  mgmtDb.updateAssignment.run({
    id: assignment.id,
    lead: profile.name,
    objective: assignment.objective,
    note: assignment.note,
    workflow: assignment.workflow,
    projects: JSON.stringify(assignment.projects),
    updatedAt: now,
  })
  // Clear the OLD lead's (terminal — guard 1) run link so lead_run_id keeps meaning
  // "the CURRENT lead's dispatched run". Re-dispatchability itself no longer hinges
  // on this: dispatch_lead's guards derive liveness from the runs row (a terminal
  // prior run never blocks) — the clear is semantic hygiene, not the unlock.
  mgmtDb.setAssignmentLeadRun.run({ id: assignment.id, leadRunId: null, updatedAt: now })
  // Audit-comment the reassign into the durable mgmt trail (the same store the
  // Chief reads via report_list), so the org's next wake sees WHY the lead moved.
  mgmtDb.insertReport.run({
    id: randomUUID(),
    runId: null,
    assignmentId: assignment.id,
    body: `Operator reassigned lead: "${oldLead}" → "${profile.name}"`,
    createdAt: now,
  })
  return rowToAssignment(mgmtDb.getAssignment.get(assignment.id) as Row)
})

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

    // The K-tier edge count for the whole-org tree (user → K → Chief → …): how many times
    // K handed work UP to the Chief. Every such hand-up is a chief activation with
    // trigger='delegation' (delegateToChief is the only path that sets it; autonomous wakes
    // use schedule/event), so this COUNT derives the K→Chief edge from the existing links.
    // 'failed' rows are excluded by the statement, which also drops delegations whose run
    // errored mid-flight — the meta reads as SUCCESSFUL hand-ups, not raw attempts (see
    // db.ts::countAgentRunsByProfileAndTrigger).
    const kDelegations = Number(
      (agentRunsDb.countAgentRunsByProfileAndTrigger.get('chief', 'delegation') as { n?: number } | undefined)?.n ?? 0,
    )

    const payload: ChiefOrgPayload = {
      chief,
      leads,
      chiefWakes,
      assignments,
      health: { leadsActive },
      kDelegations,
      // Server-authoritative live-leads count (=== health.leadsActive) — surfaced at
      // the top level so the web tree stops re-deriving it client-side.
      leadsActive,
    }
    return reply.send(payload)
  })

  // PATCH /api/chief/assignments/:id — reassign an objective to another lead.
  // 400 invalid body/unknown lead/same lead · 404 unknown assignment · 409 the current
  // lead is still working (live run OR queued dispatch intent) · 200 the updated
  // Assignment. The read→guards→update→audit sequence runs inside reassignTx (above).
  app.patch<{ Params: { id: string } }>('/api/chief/assignments/:id', async (req, reply) => {
    const parsed = ReassignBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'invalid body' })

    // The target must be a dispatchable lead profile — the same isLead gate both org
    // surfaces use, so K/Chief/default-orchestrator can never be assigned as a lead.
    // Validated OUTSIDE the tx (a profile read, not part of the assignment RMW).
    const profile = getProfile(parsed.data.leadProfileId)
    if (!profile || !isLead(profile)) return reply.status(400).send({ error: 'unknown lead' })

    try {
      return reply.send(reassignTx.immediate(req.params.id, profile))
    } catch (e) {
      // ONLY the typed guard error is a client error; anything else is a server
      // fault — re-throw so Fastify answers 500 instead of mislabelling it.
      if (e instanceof ReassignError) return reply.status(e.status).send({ error: e.message })
      throw e
    }
  })
}
