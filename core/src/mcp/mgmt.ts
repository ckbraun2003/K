/**
 * mgmt — the Chief's management working store behind the mgmt stdio MCP server.
 *
 * This module is the AUTHORITATIVE store logic for the mgmt tools (assign a lead an
 * objective, pick a workflow for it, scope its projects, write a status report up the
 * chain, and — assignment_list / report_list — READ the store back). WRITES stay
 * run-scoped (a run mutates only its own rows); READS are DURABLE across Chief
 * activations (the Chief's next wake reviews active leads + open objectives + reports
 * filed back by dispatched leads). Like logistics.ts / k-store.ts it is deliberately FREE of any
 * MCP-SDK or transport import so it can be:
 *   - unit-tested directly against the DB (see core/test/mgmt.test.ts), and
 *   - reused by the stdio MCP server (mgmt-server.ts).
 *
 * Management is ALL STORAGE, not execution: assign_lead / pick_workflow /
 * scope_projects / report persist rows, and `dispatch_lead` (loop-a P5.4, decoupled in
 * loop-b) only RECORDS a dispatch intent — it does NOT execute the lead run. This module
 * runs inside the ephemeral per-Chief-run stdio mgmt-server CHILD, which dies at the
 * Chief's turn end; a lead run + its report-back subscriber must outlive that, so
 * `dispatch_lead` seeds the run prompt and inserts a 'pending' row into the DB-backed
 * `lead_dispatches` queue that the long-lived MAIN-process relay
 * (lead-dispatch-relay.ts) drains and executes. Every row is scoped to the injected
 * K_RUN_ID, so one run can never read, mutate, or dispatch another run's management rows.
 *
 * Each tool carries its own zod input shape (authoritative validation lives in the
 * handler) plus a `ctx` with the injected K_RUN_ID.
 */
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import type { Assignment, MgmtReport } from '@k/shared'
import { db, mgmtDb, runsDb, leadDispatchDb } from '../db.js'
import { getProfile } from '../profiles.js'
import { isTerminalRunStatus } from '../run-lifecycle.js'
import {
  resolveLeadProfileId,
  resolveLeadWorkflow,
  buildLeadSeed,
  listDispatchableLeads,
  leadRosterHint,
} from '../chief-dispatch.js'

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
  // F-067: resolve + reject the lead at ASSIGN time, the SAME way dispatch_lead does
  // (resolveLeadProfileId), so the two can never disagree — an unknown lead like
  // "engineering" fails fast here with a message naming the valid leads, instead of being
  // stored as a dangling assignment that only dispatch_lead later rejects. The canonical
  // profile NAME is stored (not the raw free-text), so display + re-resolution stay stable.
  const leadProfileId = resolveLeadProfileId(a.lead)
  if (!leadProfileId) {
    throw new MgmtError(`no lead profile matches "${a.lead}". ${leadRosterHint()}`.trim())
  }
  const leadName = getProfile(leadProfileId)?.name ?? a.lead
  const now = Date.now()
  const id = uuid()
  // A fresh assignment has no workflow choice and an empty project scope yet —
  // those are set later via pick_workflow / scope_projects.
  mgmtDb.insertAssignment.run({
    id,
    runId: resolveOwnerRunId(ctx),
    lead: leadName,
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
// Read-modify-write under ONE transaction: pick_workflow/scope_projects each fetch
// the owned row, rebuild it, and UPDATE — racy across the multi-PROCESS stdio MCP
// children (one per concurrent managed run), where an interleaved writer between
// the read and the write would be silently overwritten. Hoisted module-level
// db.transaction fns (compiled once, not per call); a MgmtError thrown inside rolls
// back with nothing written, and propagates to the caller unchanged. Invoked
// `.immediate()` (the codebase's cross-process write-tx idiom — see db.ts's
// migration transaction): a DEFERRED tx that reads first can hit
// SQLITE_BUSY_SNAPSHOT on the read→write upgrade if another process commits in
// between — an error busy_timeout does NOT wait out — while IMMEDIATE takes the
// write lock up front and simply queues behind the other writer.
const pickWorkflowTx = db.transaction((a: { assignmentId: string; workflow: string }, owner: string | null): Assignment => {
  // Ownership-scoped fetch: an assignment owned by another run reads as "not found",
  // so a run can neither confirm its existence nor mutate it.
  const existing = mgmtDb.getAssignmentOwned.get(a.assignmentId, owner) as Row | undefined
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
})
function pickWorkflow(args: unknown, ctx: MgmtContext): Assignment {
  const a = z.object(PickWorkflowInput).parse(args ?? {})
  return pickWorkflowTx.immediate(a, resolveOwnerRunId(ctx))
}

const ScopeProjectsInput = {
  assignmentId: z.string().min(1).max(100),
  projects: z.array(z.string().min(1).max(200)).max(100),
}
// Same one-transaction read-modify-write as pickWorkflowTx (see its comment).
const scopeProjectsTx = db.transaction((a: { assignmentId: string; projects: string[] }, owner: string | null): Assignment => {
  // Ownership-scoped fetch (see pick_workflow) — a cross-run id reads as not found.
  const existing = mgmtDb.getAssignmentOwned.get(a.assignmentId, owner) as Row | undefined
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
})
function scopeProjects(args: unknown, ctx: MgmtContext): Assignment {
  const a = z.object(ScopeProjectsInput).parse(args ?? {})
  return scopeProjectsTx.immediate(a, resolveOwnerRunId(ctx))
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
/** RECORD (not execute): record the intent to dispatch the lead on one of this run's
 *  assignments. This tool runs inside the ephemeral per-Chief-run stdio mgmt-server CHILD
 *  process (it dies at the Chief's turn end), so it CANNOT execute the lead run itself — a
 *  lead run + its report-back subscriber must outlive the child. Instead it resolves the
 *  lead profile + the workflow scaffold, seeds the run prompt from that NamedWorkflow, and
 *  inserts a 'pending' row into the DB-backed `lead_dispatches` queue; the long-lived MAIN
 *  process relay (lead-dispatch-relay.ts::drainLeadDispatches) claims it, runs
 *  startAgentRun('lead-…', {trigger:'delegation'}), records the Chief→lead link, and wires
 *  the report-back — all in a process that stays up.
 *
 *  Guards double-dispatch two ways, both LIVENESS-DERIVED (the queue has no success-
 *  terminal status — a completed intent stays 'dispatched' forever, so "already recorded"
 *  alone can never be the test): the assignment's linked lead run is still LIVE (a
 *  terminal prior run means a follow-up dispatch is legitimate — the relay overwrites the
 *  link), OR an intent for it is still IN FLIGHT (pending, or dispatched with a live/
 *  unrecorded run — see db.ts::getActiveLeadDispatchByAssignment's derivation). Cross-run
 *  ownership is enforced too. Sync (the child await-s the value).
 *  Returns { assignmentId, leadProfileId, workflowId, dispatchId, status }. */
function dispatchLead(args: unknown, ctx: MgmtContext) {
  const a = z.object(DispatchLeadInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const row = mgmtDb.getAssignmentOwned.get(a.assignmentId, owner) as Row | undefined
  if (!row) throw new MgmtError(`assignment "${a.assignmentId}" not found for this run.`)
  // Double-dispatch guard, part 1: the linked lead run is still LIVE. Liveness is
  // DERIVED from the runs row, not from the link's existence — the relay records
  // lead_run_id on success and nothing ever clears it, so a bare "link recorded" test
  // would permanently wedge the assignment after its first completed run (no follow-up
  // dispatch ever). A terminal prior run means a NEW dispatch is a legitimate follow-up
  // wave; the relay overwrites the link when it executes the new intent.
  if (row.lead_run_id != null) {
    const priorStatus = (runsDb.getRun.get(String(row.lead_run_id)) as { status?: string } | undefined)?.status
    if (!isTerminalRunStatus(priorStatus)) {
      throw new MgmtError(
        `assignment "${a.assignmentId}" already dispatched (run ${String(row.lead_run_id)} is live).`,
      )
    }
  }
  // Double-dispatch guard, part 2: an intent for this assignment is still IN FLIGHT —
  // pending, or dispatched with a live/unrecorded run (the statement DERIVES 'active'
  // from the linked run's liveness; a completed intent is retired-by-derivation and
  // does not block — see db.ts::getActiveLeadDispatchByAssignment). Check-then-act is
  // safe because one run's mgmt tool calls are SERIALIZED over its single stdio channel
  // (one Chief agent driving one mgmt-server), so a same-assignment re-record across
  // turns is rejected.
  if (leadDispatchDb.getActiveLeadDispatchByAssignment.get(a.assignmentId)) {
    throw new MgmtError(`assignment "${a.assignmentId}" already has a pending dispatch.`)
  }
  const leadProfileId = resolveLeadProfileId(String(row.lead))
  if (!leadProfileId) throw new MgmtError(`no lead profile matches "${String(row.lead)}".`)
  const { workflowId, scaffold } = resolveLeadWorkflow(asStrOrNull(row.workflow))
  const goal = buildLeadSeed(String(row.objective), scaffold)
  // Record the intent; the MAIN-process relay drains + executes it.
  const dispatchId = uuid()
  leadDispatchDb.insertLeadDispatch.run({
    id: dispatchId,
    assignmentId: a.assignmentId,
    chiefRunId: owner,
    leadProfileId,
    lead: String(row.lead),
    workflowId,
    goal,
    createdAt: Date.now(),
  })
  return { assignmentId: a.assignmentId, leadProfileId, workflowId, dispatchId, status: 'pending' as const }
}

// ── read tools (durable across Chief activations) ─────────────────────────────

const LeadListInput = {}
/** F-067: the dispatchable lead ROSTER — the valid identifiers assign_lead / dispatch_lead
 *  accept. Read-only; derived from listProfiles().filter(isLeadProfile) via chief-dispatch,
 *  so it, the assign-time validation, and the AUTO-path seed hint can never name different
 *  sets. Each row carries the lead's id, name, discipline slug, and a one-line role note the
 *  Chief can quote when assigning. This is the tool a Chief calls to STOP inventing a
 *  discipline (e.g. "engineering") that no lead answers to. */
function leadList(): Array<{ id: string; name: string; discipline: string; role: string }> {
  return listDispatchableLeads().map(l => ({
    id: l.id,
    name: l.name,
    discipline: l.discipline,
    role: `${l.name} discipline lead (orchestrator tier). Assign with "${l.name}", "${l.id}", or "${l.discipline}".`,
  }))
}

const AssignmentListInput = { limit: z.number().int().min(1).max(100).optional() }
/** List recent assignments across Chief activations (durable read — NOT run-scoped),
 *  each enriched with the dispatched lead run's CURRENT status (null when undispatched).
 *  Lets the Chief's next activation review active leads + open objectives. */
function assignmentList(args: unknown): Array<Assignment & { leadRunStatus: string | null }> {
  const a = z.object(AssignmentListInput).parse(args ?? {})
  const limit = a.limit ?? 20
  const rows = mgmtDb.listRecentAssignments.all(limit) as Row[]
  return rows.map(row => {
    const leadRunId = row.lead_run_id
    const leadRunStatus =
      leadRunId != null
        ? ((runsDb.getRun.get(String(leadRunId)) as { status?: string } | undefined)?.status ?? null)
        : null
    return { ...rowToAssignment(row), leadRunStatus }
  })
}

const ReportListInput = { limit: z.number().int().min(1).max(100).optional() }
/** List recent status reports across Chief activations (durable read — NOT run-scoped),
 *  newest first, incl. reports filed back by dispatched leads. */
function reportList(args: unknown): MgmtReport[] {
  const a = z.object(ReportListInput).parse(args ?? {})
  const limit = a.limit ?? 20
  const rows = mgmtDb.listRecentReports.all(limit) as Row[]
  return rows.map(rowToReport)
}

// ── registry ────────────────────────────────────────────────────────────────

export interface MgmtTool {
  name: string
  description: string
  /** Raw zod shape — advertised to MCP as the tool's input schema. */
  inputShape: z.ZodRawShape
  /** Authoritative handler. Validates `args` itself; throws MgmtError on caller error.
   *  All mgmt handlers are sync (storage only); typed to allow a Promise so the server's
   *  `await tool.handler(...)` glue stays uniform. */
  handler: (args: unknown, ctx: MgmtContext) => unknown | Promise<unknown>
}

export const mgmtTools: MgmtTool[] = [
  {
    name: 'lead_list',
    description:
      'List the dispatchable leads (the valid identifiers assign_lead/dispatch_lead accept): id, name, discipline, and a one-line role. Read-only. Call this BEFORE assign_lead so you reference a real lead by name/id — never an invented discipline (e.g. "engineering") that no lead answers to.',
    inputShape: LeadListInput,
    handler: leadList,
  },
  {
    name: 'assign_lead',
    description:
      'Assign an objective to a lead in the Chief\'s management store (STORAGE, not execution — this does NOT dispatch the lead). The lead must be a real one from lead_list (a name, id, or discipline); an unknown lead is rejected. Returns the created assignment.',
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
      "Record the intent to dispatch the lead on one of this run's assignments: seeds the lead run prompt from its chosen workflow (default code-wave) and queues a dispatch that the main-process relay then executes as a supervised delegation run (recording the Chief→lead link and wiring the report-back). Guards double-dispatch (an assignment whose lead run is still LIVE, or with an in-flight dispatch intent, is rejected; a completed prior dispatch does not block a follow-up). Returns { assignmentId, leadProfileId, workflowId, dispatchId, status }.",
    inputShape: DispatchLeadInput,
    handler: dispatchLead,
  },
  {
    name: 'assignment_list',
    description:
      'List recent assignments across Chief activations (the durable management store): lead, objective, workflow, projects, and the dispatched lead run + its current status. Readable across activations — use this to review active leads and open objectives.',
    inputShape: AssignmentListInput,
    handler: assignmentList,
  },
  {
    name: 'report_list',
    description:
      'List recent status reports across Chief activations (newest first), including reports filed back by dispatched leads. Readable across activations.',
    inputShape: ReportListInput,
    handler: reportList,
  },
]
