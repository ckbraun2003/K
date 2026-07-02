/**
 * mgmt — the Chief's management working store behind the mgmt stdio MCP server.
 *
 * This module is the AUTHORITATIVE store logic for the mgmt tools (assign a lead an
 * objective, pick a workflow for it, scope its projects, and write a status report
 * up the chain). Like logistics.ts / k-store.ts it is deliberately FREE of any
 * MCP-SDK or transport import so it can be:
 *   - unit-tested directly against the DB (see core/test/mgmt.test.ts), and
 *   - reused by the stdio MCP server (mgmt-server.ts).
 *
 * Management is mostly STORAGE, not execution: assign_lead / pick_workflow /
 * scope_projects / report only persist rows — assigning a lead an objective does NOT
 * dispatch it. The ONE EXECUTION tool is `dispatch_lead` (loop-a, P5.4): the downward
 * Chief→lead hop that activates the assignment's lead as a supervised delegation run
 * seeded from its chosen NamedWorkflow, records the Chief→lead link, and wires the
 * lead's report-back. Every row is scoped to the injected K_RUN_ID, so one run can
 * never read, mutate, or dispatch another run's management rows.
 *
 * Each tool carries its own zod input shape (authoritative validation lives in the
 * handler) plus a `ctx` with the injected K_RUN_ID.
 */
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import type { Assignment, MgmtReport } from '@k/shared'
import { mgmtDb, runsDb } from '../db.js'
import { startAgentRun } from '../agent-runs.js'
import { resolveLeadProfileId, resolveLeadWorkflow, buildLeadSeed, reportLeadOutcomeToChief } from '../chief-dispatch.js'

/** Per-call context the server injects. `runId` is the managed run (K_RUN_ID). */
export interface MgmtContext {
  runId: string | null
}

/** Thrown for genuine caller errors (bad id, etc.); the glue maps it to isError. */
export class MgmtError extends Error {}

type Row = Record<string, unknown>
const asNum = (v: unknown): number => Number(v)
const asStrOrNull = (v: unknown): string | null => (v == null ? null : String(v))

/** Defensive JSON-array parse for the `projects` column: garbled/absent → []
 *  (a single corrupt row must not throw, mirroring rowToAgentProfile). */
function parseProjects(v: unknown): string[] {
  try {
    const p = JSON.parse(String(v ?? '[]'))
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

/** Map a mgmt_assignments row → the canonical Assignment shape (@k/shared).
 *  Exported so the cross-run Chief org route reuses one row-mapping authority. */
export function rowToAssignment(r: Row): Assignment {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    lead: String(r.lead),
    objective: String(r.objective),
    note: asStrOrNull(r.note),
    workflow: asStrOrNull(r.workflow),
    projects: parseProjects(r.projects),
    leadRunId: asStrOrNull(r.lead_run_id),
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

function rowToReport(r: Row): MgmtReport {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    assignmentId: asStrOrNull(r.assignment_id),
    body: String(r.body),
    createdAt: asNum(r.created_at),
  }
}

/** Owner run id, but only if that run actually exists — guards the FK and the
 *  race where K_RUN_ID is set before/without a matching runs row. */
function resolveOwnerRunId(ctx: MgmtContext): string | null {
  if (!ctx.runId) return null
  return runsDb.getRun.get(ctx.runId) ? ctx.runId : null
}

// ── handlers ──────────────────────────────────────────────────────────────────

const AssignLeadInput = {
  lead: z.string().min(1).max(200),
  objective: z.string().min(1).max(4_000),
  note: z.string().max(4_000).optional(),
}
function assignLead(args: unknown, ctx: MgmtContext): Assignment {
  const a = z.object(AssignLeadInput).parse(args ?? {})
  const now = Date.now()
  const id = uuid()
  // A fresh assignment has no workflow choice and an empty project scope yet —
  // those are set later via pick_workflow / scope_projects.
  mgmtDb.insertAssignment.run({
    id,
    runId: resolveOwnerRunId(ctx),
    lead: a.lead,
    objective: a.objective,
    note: a.note ?? null,
    workflow: null,
    projects: JSON.stringify([]),
    createdAt: now,
    updatedAt: now,
  })
  return rowToAssignment(mgmtDb.getAssignment.get(id) as Row)
}

const PickWorkflowInput = {
  assignmentId: z.string().min(1).max(100),
  workflow: z.string().min(1).max(200),
}
function pickWorkflow(args: unknown, ctx: MgmtContext): Assignment {
  const a = z.object(PickWorkflowInput).parse(args ?? {})
  // Ownership-scoped fetch: an assignment owned by another run reads as "not found",
  // so a run can neither confirm its existence nor mutate it.
  const existing = mgmtDb.getAssignmentOwned.get(a.assignmentId, resolveOwnerRunId(ctx)) as Row | undefined
  if (!existing) throw new MgmtError(`assignment "${a.assignmentId}" not found.`)
  const cur = rowToAssignment(existing)
  mgmtDb.updateAssignment.run({
    id: a.assignmentId,
    lead: cur.lead,
    objective: cur.objective,
    note: cur.note,
    workflow: a.workflow,
    projects: JSON.stringify(cur.projects),
    updatedAt: Date.now(),
  })
  return rowToAssignment(mgmtDb.getAssignment.get(a.assignmentId) as Row)
}

const ScopeProjectsInput = {
  assignmentId: z.string().min(1).max(100),
  projects: z.array(z.string().min(1).max(200)).max(100),
}
function scopeProjects(args: unknown, ctx: MgmtContext): Assignment {
  const a = z.object(ScopeProjectsInput).parse(args ?? {})
  // Ownership-scoped fetch (see pick_workflow) — a cross-run id reads as not found.
  const existing = mgmtDb.getAssignmentOwned.get(a.assignmentId, resolveOwnerRunId(ctx)) as Row | undefined
  if (!existing) throw new MgmtError(`assignment "${a.assignmentId}" not found.`)
  const cur = rowToAssignment(existing)
  mgmtDb.updateAssignment.run({
    id: a.assignmentId,
    lead: cur.lead,
    objective: cur.objective,
    note: cur.note,
    workflow: cur.workflow,
    projects: JSON.stringify(a.projects),
    updatedAt: Date.now(),
  })
  return rowToAssignment(mgmtDb.getAssignment.get(a.assignmentId) as Row)
}

const ReportInput = {
  body: z.string().min(1).max(20_000),
  assignmentId: z.string().min(1).max(100).optional(),
}
function report(args: unknown, ctx: MgmtContext): MgmtReport {
  const a = z.object(ReportInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  // A referenced assignment must be one this run owns — reject a cross-run/bogus id
  // up front (clean error, never a raw FK-constraint message from the insert).
  if (a.assignmentId !== undefined && !mgmtDb.getAssignmentOwned.get(a.assignmentId, owner)) {
    throw new MgmtError(`assignment "${a.assignmentId}" not found for this run.`)
  }
  const now = Date.now()
  const id = uuid()
  mgmtDb.insertReport.run({
    id,
    runId: owner,
    assignmentId: a.assignmentId ?? null,
    body: a.body,
    createdAt: now,
  })
  return rowToReport(mgmtDb.getReport.get(id) as Row)
}

const DispatchLeadInput = {
  assignmentId: z.string().min(1).max(100),
}
/** Execution (NOT storage): dispatch the lead recorded on one of this run's assignments.
 *  Resolves the lead profile + the workflow scaffold, seeds the run prompt from that
 *  NamedWorkflow, activates startAgentRun('lead-…', {trigger:'delegation'}), records the
 *  Chief→lead parent→child link on the assignment (lead_run_id; parent = run_id), and wires
 *  the lead→Chief report-back. Guards double-dispatch (lead_run_id already set) and cross-run
 *  ownership. Async (awaited by mgmt-server).
 *
 *  LIVE-PATH TOPOLOGY (deferred — conductor's gated live smoke / loop-b): a Chief run
 *  invokes this tool through the stdio mgmt-server CHILD, so today the lead dispatch +
 *  its report-back subscriber run bound to THAT child's process/EventBus. In-process the
 *  seams are exact (verified mocked); wiring the dispatch to the long-lived main process
 *  (so lead supervision + report-back + WS streaming outlive the Chief's turn) is a
 *  follow-up, NOT part of this seam wave. */
async function dispatchLead(args: unknown, ctx: MgmtContext) {
  const a = z.object(DispatchLeadInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const row = mgmtDb.getAssignmentOwned.get(a.assignmentId, owner) as Row | undefined
  if (!row) throw new MgmtError(`assignment "${a.assignmentId}" not found for this run.`)
  // Double-dispatch guard. This is a check-then-act around the await below; it is safe
  // because one run's mgmt tool calls are SERIALIZED over its single stdio channel (one
  // Chief agent driving one mgmt-server), so a same-assignment re-dispatch across turns
  // reads a now-set lead_run_id and is rejected. It does NOT defend truly-concurrent
  // callers on one assignment (a scenario the single-client model precludes).
  if (row.lead_run_id != null) {
    throw new MgmtError(`assignment "${a.assignmentId}" already dispatched (run ${String(row.lead_run_id)}).`)
  }
  const leadProfileId = resolveLeadProfileId(String(row.lead))
  if (!leadProfileId) throw new MgmtError(`no lead profile matches "${String(row.lead)}".`)
  const { workflowId, scaffold } = resolveLeadWorkflow(asStrOrNull(row.workflow))
  const goal = buildLeadSeed(String(row.objective), scaffold)
  // Dispatch (mocked in tests). startAgentRun rolls its own tracking row back to 'failed'
  // and re-throws on a dispatch failure — so a failure leaves lead_run_id NULL (retryable).
  const { agentRunId, runId } = await startAgentRun(leadProfileId, { trigger: 'delegation', goal, workflowId })
  // Record the parent(Chief run)→child(lead run) link on the Chief's durable assignment.
  mgmtDb.setAssignmentLeadRun.run({ id: a.assignmentId, leadRunId: runId, updatedAt: Date.now() })
  // Report the lead's terminal outcome UP to the Chief's mgmt store.
  if (owner) reportLeadOutcomeToChief(owner, runId, String(row.lead))
  return { assignmentId: a.assignmentId, leadProfileId, agentRunId, runId }
}

// ── registry ────────────────────────────────────────────────────────────────

export interface MgmtTool {
  name: string
  description: string
  /** Raw zod shape — advertised to MCP as the tool's input schema. */
  inputShape: z.ZodRawShape
  /** Authoritative handler. Validates `args` itself; throws MgmtError on caller error.
   *  May be sync (the storage tools) or async (`dispatch_lead`) — the server awaits it. */
  handler: (args: unknown, ctx: MgmtContext) => unknown | Promise<unknown>
}

export const mgmtTools: MgmtTool[] = [
  {
    name: 'assign_lead',
    description:
      'Assign an objective to a lead in the Chief\'s management store (STORAGE, not execution — this does NOT dispatch the lead). Returns the created assignment.',
    inputShape: AssignLeadInput,
    handler: assignLead,
  },
  {
    name: 'pick_workflow',
    description:
      'Record the workflow choice for one of this run\'s assignments by id. Returns the updated assignment.',
    inputShape: PickWorkflowInput,
    handler: pickWorkflow,
  },
  {
    name: 'scope_projects',
    description:
      'Set the project scope (a list of project names) for one of this run\'s assignments by id. Returns the updated assignment.',
    inputShape: ScopeProjectsInput,
    handler: scopeProjects,
  },
  {
    name: 'report',
    description:
      'Write a status report up the chain (storage only), optionally about one of this run\'s assignments. Returns the created report.',
    inputShape: ReportInput,
    handler: report,
  },
  {
    name: 'dispatch_lead',
    description:
      "Dispatch (EXECUTE) the lead recorded on one of this run's assignments: activates the lead as a supervised delegation run seeded from its chosen workflow (default code-wave), records the Chief→lead link, and wires the lead's report-back. Guards double-dispatch. Returns { assignmentId, leadProfileId, agentRunId, runId }.",
    inputShape: DispatchLeadInput,
    handler: dispatchLead,
  },
]
