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
  isKnownModel,
  type WorkItem,
  type Lesson,
  type WorkflowStep,
  type AgentMessage,
} from '@k/shared'
import { eventsDb, workItemsDb, agentMemoryDb, workflowStepsDb, workflowRunsDb, runsDb, agentRunsDb, pipelineDb, workflowDefsDb } from '../db.js'
import { getProject, getProjectByName } from '../projects.js'
import { getProfile, getProfileByName } from '../profiles.js'
import { queueMessage, mayMessage, AgentMailError } from '../agent-mail.js'
import { getOrCreateConversation } from '../agent-sessions.js'

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

// ── pipeline delegation (C1) ──────────────────────────────────────────────────

const DelegatePipelineInput = {
  pipelineId: z.string().min(1).max(100),
  goal: z.string().min(1).max(20_000),
  project: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(100).optional(),
}
/** RECORD (not execute): record the intent to run a pipeline. Like `dispatch_lead`, this tool runs
 *  inside the ephemeral per-K/Chief-run stdio MCP CHILD process (it dies at the delegating turn's
 *  end), so it CANNOT own a MULTI-run pipeline itself — the scheduler that walks the DAG + each
 *  stage's report-back must outlive the child. Instead it validates the pipeline DEFINITION exists
 *  (by workflow_definitions id, then name) + the optional project resolves, then inserts a 'pending'
 *  row into the DB-backed `pipeline_dispatches` queue scoped to the owning K run. The long-lived MAIN
 *  process relay (pipeline-dispatch-relay.ts::drainPipelineDispatches) claims it, resolves the
 *  project→cwd scope, and calls startPipelineRun — all in a process that stays up.
 *  Returns { dispatchId, pipelineId, projectId, status:'pending' }. */
function delegatePipeline(args: unknown, ctx: KStoreContext): {
  dispatchId: string
  pipelineId: string
  projectId: string | null
  status: 'pending'
} {
  const a = z.object(DelegatePipelineInput).parse(args ?? {})
  // Validate the pipeline definition exists BEFORE recording — resolve by id, then by name (the arg
  // accepts either), and pin the canonical id so the relay's startPipelineRun resolves it by id.
  const def = (workflowDefsDb.getWorkflowDefRow.get(a.pipelineId) ??
    workflowDefsDb.getWorkflowDefByNameRow.get(a.pipelineId)) as { id?: string } | undefined
  if (!def?.id) throw new KStoreError(`no pipeline definition "${a.pipelineId}".`)
  // Resolve the optional project scope (name first, then id) to its id up front — a clean error now
  // beats a silent relay-time failure. NULL scope runs the pipeline against K's own repo.
  let projectId: string | null = null
  if (a.project !== undefined) {
    const project = getProjectByName(a.project) ?? getProject(a.project)
    if (!project) throw new KStoreError(`project "${a.project}" not found.`)
    projectId = project.id
  }
  // Validate the optional model at this boundary — every HTTP entrance guards it via isKnownModel,
  // so the tool must too, else a typo flows through applyModelOverride → StageDef.model →
  // startAgentRun and every stage mis-dispatches opaquely (SEAMS F4).
  if (a.model !== undefined && !isKnownModel(a.model)) throw new KStoreError(`unknown model "${a.model}".`)
  // Record the intent ONLY (k_run_id = the owning K/Chief run, like dispatch_lead's chief_run_id);
  // the MAIN-process relay drains + executes it.
  const dispatchId = uuid()
  pipelineDb.insertPipelineDispatch.run({
    id: dispatchId,
    pipelineId: def.id,
    kRunId: resolveOwnerRunId(ctx),
    goal: a.goal,
    projectId,
    model: a.model ?? null,
    createdAt: Date.now(),
  })
  return { dispatchId, pipelineId: def.id, projectId, status: 'pending' }
}

// ── agent mailbox (Continuous Agents B.3, D-124) ─────────────────────────────

const MessageAgentInput = {
  to: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  priority: z.enum(['normal', 'urgent']).optional(),
}
/** Queue ONE message to another durable agent's conversation. The sender is resolved
 *  from the calling run (K_RUN_ID → agent_runs.profile_id) — an agent never names its
 *  own identity. mayMessage gates the pair (tier matrix); the target conversation is
 *  resolved at queue time so unread counts and relay grouping are exact. Delivery is
 *  the MAIN-process relay's job (message-relay.ts) — this tool only RECORDS, exactly
 *  like dispatch_lead/delegate_pipeline. */
function messageAgent(args: unknown, ctx: KStoreContext): {
  id: string
  to: string
  priority: AgentMessage['priority']
  status: AgentMessage['status']
} {
  const a = z.object(MessageAgentInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  if (!owner) throw new KStoreError('message_agent requires a managed run context (no run id).')
  const prof = agentRunsDb.getAgentRunProfileByRunId.get(owner) as { profile_id?: string } | undefined
  if (!prof?.profile_id) {
    throw new KStoreError('this run has no owning agent profile — only agent-org runs can send messages.')
  }
  const target = getProfile(a.to) ?? getProfileByName(a.to)
  if (!target) throw new KStoreError(`unknown agent profile "${a.to}".`)
  const from = { kind: 'profile', profileId: String(prof.profile_id) } as const
  if (!mayMessage(from, target.id)) {
    throw new KStoreError(
      `profile "${prof.profile_id}" may not message "${target.id}" (tier gate: K → anyone; ` +
        'manager → its domain + K; orchestrator → its running stages + its manager).',
    )
  }
  const thread = getOrCreateConversation(target.id)
  // The mail layer's caller errors (e.g. whitespace-only body — zod min(1) does not
  // trim) must surface TYPED, not as the generic "internal error" the glue logs for
  // unknown throws. Rewrap; genuine internal faults still propagate untouched.
  let msg: AgentMessage
  try {
    msg = queueMessage({
      toProfileId: target.id,
      toThreadId: thread.id,
      from,
      body: a.body,
      priority: a.priority,
      provenanceRunId: owner,
    })
  } catch (e) {
    if (e instanceof AgentMailError) throw new KStoreError(e.message)
    throw e
  }
  return { id: msg.id, to: target.id, priority: msg.priority, status: msg.status }
}

// ── operator ask (ui-adjustments R4, D-relocation) ────────────────────────────

const RequestInputInput = {
  question: z.string().min(1).max(2_000),
  kind: z.enum(['question', 'verification', 'feedback']).optional(),
}
/** ui-adjustments R4: the ONLY producer of a Personal-Inbox `input_needed` card.
 *  Lives on kstore — not mgmt — because kstore is the ONLY MCP server mounted on
 *  every interactive tier (chief/orchestrator/secretary; see agent-config/mcp/
 *  *.json). A dispatched lead/worker (orchestrator tier) is exactly who needs to
 *  ask the operator mid-task, so the tool must be reachable there, not just from
 *  Chief. Every interactive turn still parks the run at `awaiting_input`
 *  (supervisor.ts — untouched by this tool) so the resume/session/metrics
 *  machinery is unaffected; the inbox now surfaces a card ONLY when the agent
 *  EXPLICITLY calls this tool. It appends a durable `input_request` event (no
 *  schema bump — reuses the events table, `type='input_request'`) that
 *  inbox.ts's listInputParked query and notify.ts's awaiting_input rule both key
 *  off (ts-ordered against the run's last 'running' status event, so an answered
 *  ask never re-surfaces). Pure marker write — no run-status/session mutation;
 *  the operator's reply arrives as the agent's next turn exactly as it always
 *  has.
 *
 *  seq is NOT hand-rolled: this handler runs in the kstore MCP CHILD process,
 *  while supervisor.ts assigns seq for the SAME run's other events from its own
 *  in-memory per-process counter — both writers race into the same
 *  UNIQUE(run_id, seq) index. Reusing the hardened eventsDb pair (the same
 *  INSERT OR IGNORE every other writer uses — see events.ts::emitEvent /
 *  supervisor.ts's resume reseed) turns a same-seq collision into a silently
 *  dropped insert (changes:0) instead of a thrown SQLITE_CONSTRAINT; the bounded
 *  retry recomputes seq and tries again so the operator's ask is guaranteed to
 *  land rather than vanish. */
function requestInput(args: unknown, ctx: KStoreContext): string {
  const input = z.object(RequestInputInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  if (!owner) throw new KStoreError('request_input requires a managed run context (no run id).')
  let inserted = false
  for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
    const seq = (eventsDb.nextEventSeq.get(owner) as { next: number }).next
    const res = eventsDb.insertEvent.run({
      id: uuid(), runId: owner, seq, type: 'input_request', ts: Date.now(),
      text: input.question, raw: JSON.stringify({ kind: input.kind ?? 'question' }),
      tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
      toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
      subagentType: null, childLabel: null, contextTokens: null,
    })
    inserted = res.changes > 0
  }
  if (!inserted) throw new KStoreError('could not record input request (event seq contention)')
  return `Posted your request to the operator's inbox. End your turn; their reply arrives as your next message.`
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
  {
    name: 'delegate_pipeline',
    description:
      "Delegate a multi-agent PIPELINE (a built-in workflow like 'code-wave', 'investigate', or 'refactor') to run autonomously. pipelineId is the pipeline's id or name; goal is what it should accomplish; project (optional) scopes it to a registered project's repo (else K's own); model (optional) runs every stage on a chosen model. Records the intent — the pipeline runs in the background and reports its outcome back here. Returns { dispatchId, pipelineId, projectId, status:'pending' }.",
    inputShape: DelegatePipelineInput,
    handler: delegatePipeline,
  },
  {
    name: 'message_agent',
    description:
      "Send a message to another durable agent's conversation (the priority mailbox). `to` is the agent profile id or name; `priority` 'urgent' interrupts/steers, 'normal' (default) delivers at the next turn boundary. Tier-gated: K reaches anyone; a manager reaches its domain's agents + K; an orchestrator reaches its running stages + its manager. Returns { id, to, priority, status:'queued' } — the relay delivers it in the background.",
    inputShape: MessageAgentInput,
    handler: messageAgent,
  },
  {
    name: 'request_input',
    description:
      "Ask the operator a question, or request verification or feedback. Posts to their Personal Inbox as an input_needed card carrying your literal question; their reply arrives as your next message. Use this ONLY when you genuinely need the operator — an ordinary turn boundary does NOT notify them.",
    inputShape: RequestInputInput,
    handler: requestInput,
  },
]
