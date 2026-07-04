/**
 * kstore — the working-store tool layer behind K's stdio MCP server.
 *
 * This module is the AUTHORITATIVE store logic for the kstore tools (work-item
 * CRUD, lesson propose/list, workflow status-write). Work items span scopes: 'run'
 * is the EPHEMERAL default (visible only to the creating run); 'personal'/'org' are
 * the DURABLE operator-global store (persist across sessions + runs — the operator's
 * own list and the org-wide list); 'project' is the projects surface (not creatable
 * here). It is deliberately FREE of any MCP-SDK or transport import so it can be:
 *   - unit-tested directly against the DB (see core/test/kstore.test.ts), and
 *   - reused by both the stdio MCP server (k-store-server.ts) and, if the
 *     MCP-in-`-p` path proves flaky on Windows, a thin Bash CLI over the same store.
 *
 * Each tool carries its own zod input shape (authoritative validation lives in
 * the handler) plus a `ctx` with the injected K_RUN_ID. Status-write tools
 * resolve the workflow_runs row from that run id, so an agent never handles the
 * workflowRunId itself.
 */
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import {
  WorkItemStatusSchema,
  LessonStatusSchema,
  WorkflowStepKindSchema,
  WorkflowStepStatusSchema,
  type WorkItem,
  type Lesson,
  type WorkflowStep,
} from '@k/shared'
import { workItemsDb, agentMemoryDb, workflowStepsDb, workflowRunsDb, runsDb, agentRunsDb } from '../db.js'

/** Per-call context the server/CLI injects. `runId` is the managed run (K_RUN_ID). */
export interface KStoreContext {
  runId: string | null
}

/** A tool's handler signals a clean, non-error "you're not in a workflow" outcome. */
export interface NotInWorkflow {
  ok: false
  reason: 'not_in_workflow'
  message: string
}

/** Thrown for genuine caller errors (bad id, etc.); the glue maps it to isError. */
export class KStoreError extends Error {}

type Row = Record<string, unknown>
const asNum = (v: unknown): number => Number(v)
const asStrOrNull = (v: unknown): string | null => (v == null ? null : String(v))

/** Map a work_items row → the shared WorkItem shape. Exported as the ONE mapping
 *  authority the durable work-items HTTP route (routes/k.ts) reuses. */
export function rowToWorkItem(r: Row): WorkItem {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    title: String(r.title),
    body: asStrOrNull(r.body),
    status: r.status as WorkItem['status'],
    scope: r.scope as WorkItem['scope'],
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

function rowToLesson(r: Row): Lesson {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    lesson: String(r.lesson),
    status: r.status as Lesson['status'],
    createdAt: asNum(r.created_at),
    reviewedAt: r.reviewed_at == null ? null : asNum(r.reviewed_at),
  }
}

function rowToWorkflowStep(r: Row): WorkflowStep {
  return {
    id: String(r.id),
    workflowRunId: String(r.workflow_run_id),
    seq: asNum(r.seq),
    label: String(r.label),
    kind: r.kind as WorkflowStep['kind'],
    workItemId: asStrOrNull(r.work_item_id),
    status: r.status as WorkflowStep['status'],
    detail: asStrOrNull(r.detail),
    updatedAt: asNum(r.updated_at),
  }
}

/** Owner run id, but only if that run actually exists — guards the FK and the
 *  race where K_RUN_ID is set before/without a matching runs row. */
function resolveOwnerRunId(ctx: KStoreContext): string | null {
  if (!ctx.runId) return null
  return runsDb.getRun.get(ctx.runId) ? ctx.runId : null
}

/** Resolve the workflow_runs row for the current run; null when not in a workflow. */
function resolveWorkflowRun(ctx: KStoreContext): { id: string } | null {
  if (!ctx.runId) return null
  return (workflowStepsDb.getWorkflowRunByRunId.get(ctx.runId) as { id: string } | undefined) ?? null
}

const notInWorkflow = (): NotInWorkflow => ({
  ok: false,
  reason: 'not_in_workflow',
  message: 'This run is not bound to a workflow, so there is no status checklist to update.',
})

// ── handlers ──────────────────────────────────────────────────────────────────

/** Reject a caller trying to reach the PROJECT surface through kstore. Project
 *  tickets are created/managed via the projects API, never kstore — so `scope:
 *  'project'` on any kstore work-item arg is a clean, explicit error (the advertised
 *  schema doesn't even list it). Checked on the RAW args before the zod parse. */
function rejectProjectScope(args: unknown): void {
  if (
    args != null &&
    typeof args === 'object' &&
    (args as Record<string, unknown>).scope === 'project'
  ) {
    throw new KStoreError(
      'project tasks are created and managed through the projects surface/API, not kstore.',
    )
  }
}

// D-026 scope discriminator for creates: 'run' (default, EPHEMERAL run-scoped),
// 'personal'/'org' (DURABLE operator-global). 'project' is intentionally excluded
// (guarded above) — the advertised schema only lists the legal creates.
const WorkItemCreateInput = {
  title: z.string().min(1).max(500),
  body: z.string().max(20_000).optional(),
  scope: z.enum(['run', 'personal', 'org']).optional(),
}
function workItemCreate(args: unknown, ctx: KStoreContext): WorkItem {
  rejectProjectScope(args)
  const a = z.object(WorkItemCreateInput).parse(args ?? {})
  const now = Date.now()
  const id = uuid()
  // run_id is recorded on every insert as PROVENANCE — even a durable item records
  // which run created it. The scope decides visibility, not run_id.
  workItemsDb.insertWorkItem.run({
    id,
    runId: resolveOwnerRunId(ctx),
    title: a.title,
    body: a.body ?? null,
    status: 'open',
    scope: a.scope ?? 'run',
    createdAt: now,
    updatedAt: now,
  })
  return rowToWorkItem(workItemsDb.getWorkItem.get(id) as Row)
}

const WorkItemListInput = {
  status: WorkItemStatusSchema.optional(),
  scope: z.enum(['run', 'personal', 'org']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}
function workItemList(args: unknown, ctx: KStoreContext): WorkItem[] {
  rejectProjectScope(args)
  const a = z.object(WorkItemListInput).parse(args ?? {})
  const limit = a.limit ?? 50
  // Durable scopes ('personal'/'org') read the operator-global store — NO run filter.
  if (a.scope === 'personal' || a.scope === 'org') {
    const rows = (
      a.status
        ? workItemsDb.listWorkItemsByScopeStatus.all(a.scope, a.status, limit)
        : workItemsDb.listWorkItemsByScope.all(a.scope, limit)
    ) as Row[]
    return rows.map(rowToWorkItem)
  }
  // Default ('run', or omitted): scoped to the caller's run — a run never lists
  // another run's ephemeral tickets (unchanged semantics).
  const owner = resolveOwnerRunId(ctx)
  const rows = (
    a.status
      ? workItemsDb.listWorkItemsByRunStatus.all(owner, a.status, limit)
      : workItemsDb.listWorkItemsByRun.all(owner, limit)
  ) as Row[]
  return rows.map(rowToWorkItem)
}

const WorkItemUpdateInput = {
  id: z.string().min(1).max(100),
  status: WorkItemStatusSchema.optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(20_000).optional(),
}
function workItemUpdate(args: unknown, ctx: KStoreContext): WorkItem {
  const a = z.object(WorkItemUpdateInput).parse(args ?? {})
  if (a.status === undefined && a.title === undefined && a.body === undefined) {
    throw new KStoreError('work_item_update needs at least one of: status, title, body.')
  }
  // Two-step resolve. First the run-scoped ownership fetch: a 'run' item owned by
  // another run reads as "not found". If that misses, try the DURABLE store: a
  // 'personal'/'org' item is operator-global — updatable from ANY run (incl. a null
  // owner). 'project' rows stay unreachable (both statements exclude them). Scope
  // itself is never updated.
  const existing = (workItemsDb.getWorkItemOwned.get(a.id, resolveOwnerRunId(ctx)) ??
    workItemsDb.getWorkItemDurable.get(a.id)) as Row | undefined
  if (!existing) throw new KStoreError(`work item "${a.id}" not found.`)
  const cur = rowToWorkItem(existing)
  workItemsDb.updateWorkItem.run({
    id: a.id,
    title: a.title ?? cur.title,
    body: a.body !== undefined ? a.body : cur.body,
    status: a.status ?? cur.status,
    updatedAt: Date.now(),
  })
  return rowToWorkItem(workItemsDb.getWorkItem.get(a.id) as Row)
}

const LessonProposeInput = { lesson: z.string().min(1).max(4_000) }
function lessonPropose(args: unknown, ctx: KStoreContext): Lesson {
  const a = z.object(LessonProposeInput).parse(args ?? {})
  const id = uuid()
  // Resolve the calling run's proposing profile (via its agent_runs activation) so a
  // lesson lands linked to who proposed it — the memory-gate review surface reads it,
  // and it seeds per-profile retrieval. Best-effort: a run with no agent_runs row → null.
  const owner = resolveOwnerRunId(ctx)
  const prof = owner
    ? (agentRunsDb.getAgentRunProfileByRunId.get(owner) as { profile_id?: string } | undefined)
    : undefined
  agentMemoryDb.insertLesson.run({
    id,
    runId: owner,
    lesson: a.lesson,
    status: 'pending',
    createdAt: Date.now(),
    reviewedAt: null,
    profileId: prof?.profile_id ?? null,
  })
  // Fetch by the generated id (status stays 'pending' — layer-A gated).
  return rowToLesson(agentMemoryDb.getLesson.get(id) as Row)
}

const LessonListInput = {
  status: LessonStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}
function lessonList(args: unknown, ctx: KStoreContext): Lesson[] {
  const a = z.object(LessonListInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const limit = a.limit ?? 50
  // Scoped to the caller's run — a run only sees the lessons it proposed.
  const rows = (
    a.status
      ? agentMemoryDb.listLessonsByRunStatus.all(owner, a.status, limit)
      : agentMemoryDb.listLessonsByRun.all(owner, limit)
  ) as Row[]
  return rows.map(rowToLesson)
}

const WorkflowStepSetInput = {
  label: z.string().min(1).max(200),
  kind: WorkflowStepKindSchema,
  status: WorkflowStepStatusSchema,
  detail: z.string().max(2_000).optional(),
  workItemId: z.string().min(1).max(100).optional(),
}
/** F-071: does `detail` carry PR/CI evidence — a URL or a PR reference (#123 / pull/123)?
 *  A CI/PR gate step can only be marked done when it names the artifact it gated on, so a
 *  remoteless "done with no PR" can't pass the gate at face value. SOFT GATE: this checks the
 *  PRESENCE/format of a reference, not that the PR exists or CI is actually green — it stops
 *  the blatant "done with nothing" case, not a fabricated reference (deeper verification is out
 *  of scope for a status-write tool). */
function hasPrEvidence(detail: string | undefined): boolean {
  if (detail == null) return false
  return /https?:\/\/\S+/i.test(detail) || /#\d+/.test(detail) || /\bpull\/\d+/i.test(detail)
}

function workflowStepSet(args: unknown, ctx: KStoreContext): WorkflowStep | NotInWorkflow {
  const a = z.object(WorkflowStepSetInput).parse(args ?? {})
  const wf = resolveWorkflowRun(ctx)
  if (!wf) return notInWorkflow()
  // F-071: a CI/PR gate step (kind 'ci') cannot be marked 'done' without evidence — a PR
  // reference or url in `detail`. Reject fail-fast (the agent must supply the artifact) so
  // a gate is never taken at face value with no PR behind it. Other kinds are unaffected.
  if (a.kind === 'ci' && a.status === 'done' && !hasPrEvidence(a.detail)) {
    throw new KStoreError(
      'a CI/PR gate step cannot be marked done without evidence: put the PR reference or url ' +
        '(e.g. the PR url, #number, or pull/<n>) in `detail`, or set the step blocked instead.',
    )
  }
  // A linked ticket must be one this run owns — reject a cross-run/bogus id up
  // front (clean error, and never a raw FK-constraint message from the insert).
  if (a.workItemId !== undefined && !workItemsDb.getWorkItemOwned.get(a.workItemId, resolveOwnerRunId(ctx))) {
    throw new KStoreError(`work item "${a.workItemId}" not found for this run.`)
  }
  const row = workflowStepsDb.setWorkflowStep({
    id: uuid(),
    workflowRunId: wf.id,
    label: a.label,
    kind: a.kind,
    workItemId: a.workItemId ?? null,
    status: a.status,
    detail: a.detail ?? null,
    updatedAt: Date.now(),
  }) as Row
  return rowToWorkflowStep(row)
}

const WorkflowStatusSetInput = { status: z.enum(['running', 'completed', 'failed']) }
// NB: the agent's overall-status write is a MID-RUN signal. When the run reaches a
// terminal state, workflows.ts::finalizeWorkflowRun re-derives and overwrites this
// from the actual run outcome (done→completed, else failed) — the supervisor is the
// authoritative source at termination. Per-step (workflow_step_set) is the durable surface.
function workflowStatusSet(args: unknown, ctx: KStoreContext): { ok: true; status: string } | NotInWorkflow {
  const a = z.object(WorkflowStatusSetInput).parse(args ?? {})
  const wf = resolveWorkflowRun(ctx)
  if (!wf) return notInWorkflow()
  const completedAt = a.status === 'running' ? null : Date.now()
  workflowRunsDb.updateWorkflowRunStatus.run(a.status, completedAt, wf.id)
  return { ok: true, status: a.status }
}

// ── registry ────────────────────────────────────────────────────────────────

export interface KStoreTool {
  name: string
  description: string
  /** Raw zod shape — advertised to MCP as the tool's input schema. */
  inputShape: z.ZodRawShape
  /** Authoritative handler. Validates `args` itself; throws KStoreError on caller error. */
  handler: (args: unknown, ctx: KStoreContext) => unknown
}

export const kStoreTools: KStoreTool[] = [
  {
    name: 'work_item_create',
    description:
      "Create a work item (ticket). scope='run' (default) is EPHEMERAL — visible only to this run. scope='personal' (the operator's own list) and scope='org' (org-wide) are DURABLE — they persist across sessions and runs. Project tasks cannot be created here (use the projects surface). Returns the created item.",
    inputShape: WorkItemCreateInput,
    handler: workItemCreate,
  },
  {
    name: 'work_item_list',
    description:
      "List work items. scope='run' (default) lists this run's ephemeral tickets; scope='personal' or scope='org' lists the durable operator-global store that persists across sessions. Optionally filter by status. Returns an array of items.",
    inputShape: WorkItemListInput,
    handler: workItemList,
  },
  {
    name: 'work_item_update',
    description:
      "Update a work item by id — set its status and/or edit its title/body. 'run'-scoped items must belong to this run; durable 'personal'/'org' items can be updated from any session. Returns the updated item.",
    inputShape: WorkItemUpdateInput,
    handler: workItemUpdate,
  },
  {
    name: 'lesson_propose',
    description:
      'Propose ONE durable lesson to memory. It is held pending an operator\'s approval (gated reflection) — memory is a tool, not a file. Returns the proposed lesson.',
    inputShape: LessonProposeInput,
    handler: lessonPropose,
  },
  {
    name: 'lesson_list',
    description:
      'List this run\'s proposed/accepted lessons, optionally filtered by status. Returns an array.',
    inputShape: LessonListInput,
    handler: lessonList,
  },
  {
    name: 'workflow_step_set',
    description:
      'Report one checklist line of the current workflow (a ticket, loop phase, review, or CI gate) by label — upserts its status/detail. Returns the step, or a clean notice if this run is not in a workflow.',
    inputShape: WorkflowStepSetInput,
    handler: workflowStepSet,
  },
  {
    name: 'workflow_status_set',
    description:
      'Set the overall status of the current workflow run (running | completed | failed). Returns ok, or a clean notice if this run is not in a workflow.',
    inputShape: WorkflowStatusSetInput,
    handler: workflowStatusSet,
  },
]
