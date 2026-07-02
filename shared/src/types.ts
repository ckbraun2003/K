import { z } from 'zod'

// ─── Run ────────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_input', // non-terminal: an interactive run finished a turn and is waiting
                    // for the operator's next message (stdin held open). Swept to
                    // 'interrupted' at boot like running/queued (the child can't survive).
  'done',
  'error',
  'killed',
  'interrupted', // terminal: run was running/queued/awaiting_input when core restarted
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string(),
  cwd: z.string(),
  worktree: z.string().optional(),
  status: RunStatusSchema,
  provider: z.enum(['claude', 'ollama']),
  model: z.string(),
  tokensIn: z.number().int().default(0),
  tokensOut: z.number().int().default(0),
  costUsd: z.number().default(0),
  projectId: z.string().uuid().optional(),
  createdAt: z.number(), // unix ms
  endedAt: z.number().optional(),
})
export type Run = z.infer<typeof RunSchema>

// ─── AgentEvent ─────────────────────────────────────────────────────────────
// Maps from claude --output-format stream-json line types

export const AgentEventTypeSchema = z.enum([
  'system',      // session_start / session_end
  'assistant',   // assistant turn (text / tool_use)
  'user',        // user turn (tool_result)
  'usage',       // token + cost snapshot
  'error',       // parse or process error
  'status',      // synthetic: queued | running | done | killed
])
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>

export const AgentEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int(),           // monotonic within a run
  type: AgentEventTypeSchema,
  ts: z.number(),                  // unix ms
  raw: z.string().optional(),      // original JSON line (for replay)
  // convenience projections (populated by supervisor)
  text: z.string().optional(),     // display text
  tool: z.string().optional(),     // tool name if tool_use
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  costUsd: z.number().optional(),
  // total input context size for this assistant turn (fresh input_tokens +
  // cache_creation_input_tokens + cache_read_input_tokens). Distinct from
  // `tokensIn` (fresh input only) so cost/metrics accounting is unchanged; used
  // by the context-pressure indicator.
  contextTokens: z.number().optional(),
  // ── enriched tool metadata (populated by the enriched parseClaudeLine) ──────
  // A tool_use block (on an `assistant` event) and its matching tool_result
  // block (on a later `user` event) PAIR by `toolUseId`. Later waves render
  // commands / file ops / delegated sub-agents from these structured fields.
  toolUseId: z.string().optional(),                                  // join key: block.id (tool_use) / block.tool_use_id (tool_result)
  toolKind: z.enum(['command', 'file', 'delegate', 'other']).optional(), // discriminator for rendering
  toolInput: z.unknown().optional(),                                 // raw tool_use input object (JSON)
  toolResult: z.unknown().optional(),                                // tool_result content, as-is (string or array)
  toolResultIsError: z.boolean().optional(),                         // tool_result is_error (omitted when absent)
  subagentType: z.string().optional(),                              // delegate only; absent → default agent
  childLabel: z.string().optional(),                               // delegate only: human label for the spawned agent
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

// ─── Artifact ────────────────────────────────────────────────────────────────

export const ArtifactSchema = z.object({
  slug: z.string(),          // filename without extension, URL-safe
  title: z.string(),
  phase: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).default([]),
  linkedRunId: z.string().uuid().optional(),
  updatedAt: z.number(),     // unix ms
  md: z.string(),            // raw markdown content
  html: z.string().optional(), // rendered html (generated, not stored in DB)
})
export type Artifact = z.infer<typeof ArtifactSchema>

// ─── Project ────────────────────────────────────────────────────────────────
// A registry entry: local git repo + GitHub remote managed by the harness.
// Invariants (enforced by verification): GitHub remote, docs/bible/, CI workflows.

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  localPath: z.string(),               // absolute path to the repo on disk
  githubRemote: z.string().optional(), // "owner/repo"
  workspaceManaged: z.boolean().default(false), // true if harness cloned it
  bibleDir: z.string().default('docs/bible'),
  healthScore: z.number().min(0).max(100).optional(),
  lastVerifiedAt: z.number().optional(), // unix ms
  createdAt: z.number(),
})
export type Project = z.infer<typeof ProjectSchema>

// ─── VerificationReport ─────────────────────────────────────────────────────
// Output of the verify-project skill (agent team audit).

export const FindingSchema = z.object({
  severity: z.enum(['info', 'warn', 'critical']),
  area: z.string(),    // e.g. "ci", "tests", "bible", "pr-review"
  message: z.string(),
})
export type Finding = z.infer<typeof FindingSchema>

export const VerificationReportSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  score: z.number().min(0).max(100),
  findings: z.array(FindingSchema).default([]),
  fixesApplied: z.array(z.string()).default([]),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  // Per-factor weighted score components (mirrors verify.ts HealthBreakdown).
  // Optional so reports persisted before this field still validate.
  breakdown: z
    .object({ ci: z.number(), coverage: z.number(), bible: z.number(), findings: z.number() })
    .optional(),
  // Measured overall line-coverage % at verify time; null when the project emits no
  // coverage-summary. Optional so reports persisted before this field still validate.
  coveragePct: z.number().nullable().optional(),
})
export type VerificationReport = z.infer<typeof VerificationReportSchema>

// ─── Metrics ────────────────────────────────────────────────────────────────

export const DailyMetricSchema = z.object({
  date: z.string(),            // YYYY-MM-DD (local)
  runs: z.number().int(),
  tokens: z.number().int(),
  costUsd: z.number(),
})
export type DailyMetric = z.infer<typeof DailyMetricSchema>

export const MetricsSummarySchema = z.object({
  today: DailyMetricSchema,
  activeRuns: z.number().int(),
  totalRuns: z.number().int(), // lifetime total — not limited to the 14-day window
  daily: z.array(DailyMetricSchema),  // oldest → newest, last 14 days incl. today
})
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>

// ─── Metrics time series ─────────────────────────────────────────────────────

export const TimeseriesGroupBySchema = z.enum(['project', 'model'])
export type TimeseriesGroupBy = z.infer<typeof TimeseriesGroupBySchema>

export const TimeseriesPointSchema = z.object({
  runs: z.number().int(),
  tokens: z.number().int(),   // tokens_in + tokens_out
  costUsd: z.number(),
})
export type TimeseriesPoint = z.infer<typeof TimeseriesPointSchema>

export const TimeseriesSeriesSchema = z.object({
  key: z.string(),    // project id | model name | 'unassigned' | 'other'
  label: z.string(),  // project name | model name | 'Unassigned' | 'Other'
  points: z.array(TimeseriesPointSchema),  // length === dates.length, zero-filled
  total: TimeseriesPointSchema,            // sums over the window
})
export type TimeseriesSeries = z.infer<typeof TimeseriesSeriesSchema>

export const MetricsTimeseriesSchema = z.object({
  groupBy: TimeseriesGroupBySchema,
  days: z.number().int(),
  dates: z.array(z.string()),              // YYYY-MM-DD local, oldest → newest
  series: z.array(TimeseriesSeriesSchema), // sorted by total.tokens desc, 'other' last
})
export type MetricsTimeseries = z.infer<typeof MetricsTimeseriesSchema>

// ─── GitHub (gh CLI projections) ────────────────────────────────────────────

export const PrInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),               // OPEN | MERGED | CLOSED
  url: z.string(),
  checks: z.enum(['passing', 'failing', 'pending', 'none']),
})
export type PrInfo = z.infer<typeof PrInfoSchema>

export const CiRunInfoSchema = z.object({
  id: z.number(),
  workflow: z.string(),
  branch: z.string(),
  status: z.string(),              // completed | in_progress | queued
  conclusion: z.string().nullable(), // success | failure | … | null while running
  createdAt: z.string(),
})
export type CiRunInfo = z.infer<typeof CiRunInfoSchema>

export const GithubStatusSchema = z.object({
  prs: z.array(PrInfoSchema),
  ci: z.array(CiRunInfoSchema),
  fetchedAt: z.number().nullable(),  // null = never fetched
})
export type GithubStatus = z.infer<typeof GithubStatusSchema>

// ─── Knowledge graph ──────────────────────────────────────────────────────────
// Per-project code graph, built by orchestrating `npx gitnexus analyze`. The graph
// data itself lives in the project's .gitnexus/ dir; K tracks build state here.

export const GraphBuildStatusSchema = z.enum(['idle', 'building', 'ready', 'error'])
export type GraphBuildStatus = z.infer<typeof GraphBuildStatusSchema>

export const ProjectGraphMetaSchema = z.object({
  projectId: z.string(),
  status: GraphBuildStatusSchema,
  builtAt: z.number().nullable(),     // unix ms of last successful build
  lastCommit: z.string().nullable(),  // git HEAD captured at last build (from .gitnexus/meta.json)
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  error: z.string().nullable(),       // last build error message, if status === 'error'
})
export type ProjectGraphMeta = z.infer<typeof ProjectGraphMetaSchema>

// Best-effort, per-node enrichment facts derived from EXISTING harness data
// (Wave 2). Every field is optional: a node only carries the facts we could
// genuinely derive, and an absent/errored data source is simply omitted — the
// GET /graph request never fails over enrichment.
export const GraphNodeEnrichmentSchema = z.object({
  // Most recent run whose prompt referenced this node's file/label.
  lastRun: z
    .object({
      runId: z.string(),
      status: z.string(),
      createdAt: z.number(),
    })
    .optional(),
  // Verification findings (from the project's latest report) referencing this file.
  findings: z.array(FindingSchema).optional(),
  // True if the node's file is referenced in the compiled project bible.
  inBible: z.boolean().optional(),
})
export type GraphNodeEnrichment = z.infer<typeof GraphNodeEnrichmentSchema>

// GET /api/projects/:id/graph response — render data + build metadata.
export const GraphResponseSchema = z.object({
  nodes: z.array(z.record(z.unknown())),
  links: z.array(z.record(z.unknown())),
  stale: z.boolean(),                 // true if never built or HEAD has moved since the build
  status: GraphBuildStatusSchema,
  builtAt: z.number().nullable(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  error: z.string().nullable(),
})
export type GraphResponse = z.infer<typeof GraphResponseSchema>

// POST /api/projects/:id/graph/dispatch body — launch a node-scoped agent run.
// nodeId is required; file/action refine the generated prompt. Validated at the
// route boundary (400 on invalid) per lessons.md "validate user input at the boundary".
// nodeId/file are interpolated into an agent prompt, so reject newlines and other
// control characters at the boundary: a single-line value can't smuggle injected
// instructions across lines. (Rejects \n, \r, \t, all C0 control chars, and DEL.)
// eslint-disable-next-line no-control-regex
const SINGLE_LINE = /^[^\x00-\x1F\x7F]+$/
export const GraphDispatchBodySchema = z.object({
  nodeId: z.string().min(1).max(1000).regex(SINGLE_LINE, 'must be a single line'),
  file: z.string().min(1).max(1000).regex(SINGLE_LINE, 'must be a single line').optional(),
  action: z.enum(['investigate', 'fix', 'explain']).optional(),
})
export type GraphDispatchBody = z.infer<typeof GraphDispatchBodySchema>

// POST /api/projects/:id/tasks/dispatch body — run a single supervised delegation
// workflow over the selected todos. Validated at the route boundary (400 on
// invalid) per lessons.md "validate user input at the boundary". Mirrors
// GraphDispatchBodySchema. Bounded 1..50 so a stray select-all can't fan out.
export const DispatchTasksBodySchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(50),
})
export type DispatchTasksBody = z.infer<typeof DispatchTasksBodySchema>

// ─── WebSocket messages ──────────────────────────────────────────────────────

export const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: AgentEventSchema }),
  z.object({ type: z.literal('run_update'), run: RunSchema }),
  // GitHub polling deltas (PR state change, CI conclusion change, issue sync)
  z.object({
    type: z.literal('github_update'),
    projectId: z.string(),
    kind: z.enum(['pr', 'ci', 'issue']),
    payload: z.unknown(),
  }),
  // Verification skill progress + final report
  z.object({ type: z.literal('verification_update'), report: VerificationReportSchema }),
  // Knowledge-graph build state transition (building → ready/error) + reindex marks
  z.object({ type: z.literal('graph_update'), projectId: z.string(), meta: ProjectGraphMetaSchema }),
  // Ollama model pull progress — transient, not persisted
  z.object({
    type: z.literal('ollama_pull'),
    name: z.string(),
    status: z.string(),
    completed: z.number().optional(),
    total: z.number().optional(),
    percent: z.number().optional(),   // 0..100, computed when total>0
    done: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
])
export type WsMessage = z.infer<typeof WsMessageSchema>

// ─── API shapes ──────────────────────────────────────────────────────────────

// Model registry — single source of truth for the per-run model picker. The UI
// builds its options from this list; the route validates `model` against it.
// `contextWindow` is the standard 200k Claude context window for all four models
// (Fable 5 assumed 200k pending confirmation); it powers the context-pressure
// indicator (web/src/lib/context.ts).
export const KNOWN_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 200_000 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', contextWindow: 200_000 },
  { id: 'claude-fable-5', label: 'Fable 5', contextWindow: 200_000 },
] as const
export type KnownModelId = typeof KNOWN_MODELS[number]['id']
export function isKnownModel(id: string): id is KnownModelId {
  return KNOWN_MODELS.some(m => m.id === id)
}

/** The model's context-window size in tokens, or `undefined` for an unknown id
 *  (e.g. a local/Ollama model). Used by the context-pressure indicator. */
export function modelContextWindow(id: string): number | undefined {
  return KNOWN_MODELS.find(m => m.id === id)?.contextWindow
}

export const StartRunBodySchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().optional(),       // defaults to k/ root
  model: z.string().optional(),     // defaults to router decision
  projectId: z.string().uuid().optional(), // explicit project association (overrides cwd inference)
  preferLocal: z.boolean().optional(), // route local-model preference; UI "Ollama (local)" sets this
  interactive: z.boolean().optional(), // keep stdin open for multi-turn HITL (claude only)
})
export type StartRunBody = z.infer<typeof StartRunBodySchema>

/** Body for POST /api/runs/:id/input — the operator's next turn in an interactive
 *  run. Newlines allowed (multi-line answers); bounded so a huge paste can't be
 *  shoved down the agent's stdin. */
export const SendInputBodySchema = z.object({
  text: z.string().min(1).max(20000),
})
export type SendInputBody = z.infer<typeof SendInputBodySchema>

export const RunsQuerySchema = z.object({
  status: RunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  projectId: z.string().uuid().optional(),
})
export type RunsQuery = z.infer<typeof RunsQuerySchema>

// ─── ProjectTask ─────────────────────────────────────────────────────────────

export const ProjectTaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(['open', 'in_progress', 'done']),
  createdAt: z.number(),
  completedAt: z.number().nullable().optional(),
  // GitHub Issues sync — present when a task mirrors an issue (Wave 3-7)
  issueNumber: z.number().int().nullable().optional(),
  issueUrl: z.string().nullable().optional(),
  issueState: z.string().nullable().optional(),
})
export type ProjectTask = z.infer<typeof ProjectTaskSchema>

// ─── WorkflowRun ─────────────────────────────────────────────────────────────
// One supervised delegation-workflow run over a batch of selected todos. `runId`
// is null until the underlying agent run is created (patched in after dispatch).
// `mode` is a literal so adding modes later is an explicit, reviewable change.
export const WorkflowRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  taskIds: z.array(z.string()),
  mode: z.literal('combined'),
  status: z.enum(['running', 'completed', 'failed']),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
})
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>

// ─── AgentProfile (agent org — P5.0) ───────────────────────────────────────
// The K-owned durable identity for a managed run. One entity differentiated by
// an authority `tier` (bible §03, D-020): secretary (K) · chief · orchestrator
// (leads). `charter` is the charter-asset BASENAME the profile materializes
// (=== tier for the durable tiers) — the actual charter PROMPT lives in
// agent-config/tiers/<charter>.charter.md (single source, loaded by the
// synthesizer), never inlined here. `allowedTools`/`mcpServers`/`skills` are the
// resolved authority for the tier (authority.ts), mirrored onto the row so the
// grant is a durable, inspectable record. This schema is the canonical type-truth
// that core/src/profiles.ts's interface mirrors.
export const AgentTierSchema = z.enum(['secretary', 'chief', 'orchestrator'])
export type AgentTier = z.infer<typeof AgentTierSchema>

export const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: AgentTierSchema,
  charter: AgentTierSchema, // charter-asset basename (=== tier for durable tiers)
  defaultModel: z.string(), // KNOWN_MODELS id
  allowedTools: z.array(z.string()), // claude --allowedTools allowlist (tier-gated)
  mcpServers: z.array(z.string()), // tier-scoped MCP servers this profile mounts
  skills: z.array(z.string()), // skill dir names this profile mounts
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

// ─── WorkItem (kstore) ─────────────────────────────────────────────────────
// A "ticket" in K's working store — STORAGE, not execution. Managed agents
// create/track work items through the kstore MCP tool instead of the home-dev
// `tasks/*.md` files. `runId` is the managed run that created it (resolved from
// the injected K_RUN_ID), null for items not tied to a run.
export const WorkItemStatusSchema = z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled'])
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>

// D-026 unified-task-store discriminator. `run` = the ephemeral run-scoped default
// (a ticket visible only to the run that created it — the kstore working default);
// `personal`/`org` = the DURABLE operator-global store (persists across sessions and
// runs — `personal` is the operator's own list, `org` is org-wide); `project` = the
// project task surface (folded in via P5.1d2).
export const WorkItemScopeSchema = z.enum(['run', 'personal', 'org', 'project'])
export type WorkItemScope = z.infer<typeof WorkItemScopeSchema>

export const WorkItemSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  status: WorkItemStatusSchema,
  scope: WorkItemScopeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkItem = z.infer<typeof WorkItemSchema>

// ─── Lesson (agent memory, layer A) ────────────────────────────────────────
// Gated reflection: an agent PROPOSES a durable lesson through the kstore tool;
// it lands `pending` and joins memory only when an operator accepts it. Memory
// is a tool, never a file.
export const LessonStatusSchema = z.enum(['pending', 'accepted', 'rejected'])
export type LessonStatus = z.infer<typeof LessonStatusSchema>

export const LessonSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  lesson: z.string(),
  status: LessonStatusSchema,
  createdAt: z.number(),
  reviewedAt: z.number().nullable(),
})
export type Lesson = z.infer<typeof LessonSchema>

// ─── WorkflowStep (status / progress checklist) ────────────────────────────
// One checklist line the orchestrator reports through the kstore status-write
// tool, keyed to a workflow_runs row. `kind` distinguishes a ticket, a loop
// phase, a review, and a CI gate; `label` is the upsert key within a run.
export const WorkflowStepKindSchema = z.enum(['task', 'phase', 'review', 'ci'])
export type WorkflowStepKind = z.infer<typeof WorkflowStepKindSchema>

export const WorkflowStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'done',
  'blocked',
  'failed',
])
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>

export const WorkflowStepSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  seq: z.number().int(),
  label: z.string(),
  kind: WorkflowStepKindSchema,
  workItemId: z.string().nullable(),
  status: WorkflowStepStatusSchema,
  detail: z.string().nullable(),
  updatedAt: z.number(),
})
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

// ─── Logistics working store (calendar / notes / scheduling) ────────────────
// K's secretary-tier logistics working store — STORAGE, not execution. Notes,
// calendar events, and reminders reached through the logistics MCP tool (never a
// file), run-scoped exactly like the kstore work-items: `runId` is the managed run
// that created the row (resolved from the injected K_RUN_ID), null for rows not
// tied to a run. Storing a calendar event here does NOT schedule it on any real
// calendar — that is a separate (connector) concern.
export const NoteSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  body: z.string(),
  done: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Note = z.infer<typeof NoteSchema>

export const CalendarEventSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  title: z.string(),
  startsAt: z.number(),
  endsAt: z.number().nullable(),
  location: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>

export const ReminderStatusSchema = z.enum(['pending', 'done', 'cancelled'])
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>

export const ReminderSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  text: z.string(),
  remindAt: z.number(),
  status: ReminderStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Reminder = z.infer<typeof ReminderSchema>

// ─── AgentRun (agent-org activation — P5.0) ─────────────────────────────────
// One activation of a durable profile into a supervised run (startAgentRun). The
// wire projection of an `agent_runs` row, mirroring the core interface. `runId` is
// null until the run is created; `trigger` records HOW the profile was activated.
// Consumed by the Chief org-status surface as a lead's / the Chief's "wake" history.
export const AgentRunTriggerSchema = z.enum(['user-message', 'schedule', 'event', 'delegation'])
export type AgentRunTrigger = z.infer<typeof AgentRunTriggerSchema>

export const AgentRunStatusSchema = z.enum(['running', 'completed', 'failed'])
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>

export const AgentRunSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  runId: z.string().nullable(),
  trigger: AgentRunTriggerSchema,
  goal: z.string().nullable(),
  projectId: z.string().nullable(),
  workflowId: z.string().nullable(),
  status: AgentRunStatusSchema,
  createdAt: z.number(),
  completedAt: z.number().nullable(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

// ─── Management working store (Chief org — P5.2a) ───────────────────────────
// The Chief's management working store — STORAGE, not execution. An `Assignment`
// is an objective the Chief hands a lead; a `MgmtReport` is a status write up the
// chain. Persisting an assignment here does NOT dispatch the lead (autonomous
// K→Chief→lead delegation is P5.2b). Run-scoped exactly like the logistics store:
// `runId` is the managed run that created the row (resolved from the injected
// K_RUN_ID), null for rows not tied to a run.
export const AssignmentSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  lead: z.string(), // a lead name / profile id the objective is assigned to
  objective: z.string(),
  note: z.string().nullable(),
  workflow: z.string().nullable(), // the workflow choice for this assignment (pick_workflow)
  projects: z.array(z.string()), // project scope (scope_projects); [] until scoped
  leadRunId: z.string().nullable(), // the dispatched lead's run id (dispatch_lead); null until dispatched — the Chief→lead parent→child link (parent = runId)
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Assignment = z.infer<typeof AssignmentSchema>

export const MgmtReportSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  assignmentId: z.string().nullable(), // the assignment this report is about, when any
  body: z.string(),
  createdAt: z.number(),
})
export type MgmtReport = z.infer<typeof MgmtReportSchema>

// ─── DelegationTree (Chief org view — P5.2a) ────────────────────────────────
// A pure VIEW type for the recursive delegation tree: Chief → leads → each lead's
// sub-agents. It is DERIVED from run events (never a stored table) — see
// web/src/lib/delegation.ts — so it is a plain recursive interface rather than a
// zod schema (a recursive z.lazy buys nothing for a view type that is never parsed
// off the wire). Kept generic + minimal so the DelegationTree component can render
// a whole-org root OR a single-lead root (P5.3 reuse).
export type DelegationNodeStatus = 'running' | 'done' | 'error' | 'idle' | 'queued'

export interface DelegationNode {
  /** Stable id, unique within the tree (profile id, run id, or delegate tool_use id). */
  id: string
  /** Display label (Chief / lead name / sub-agent type). */
  label: string
  /** Optional node kind for the inspector (e.g. 'chief' | 'lead' | 'sub-agent'). */
  kind?: string
  status: DelegationNodeStatus
  /** Optional one-line detail for the inspector (e.g. the latest run's prompt). */
  meta?: string
  children: DelegationNode[]
}

// ─── ChiefOrgPayload (GET /api/chief/org — P5.2a) ───────────────────────────
// The ONE batched read that feeds the Chief org-status page. Assembled server-side
// (core/src/routes/chief.ts) so the page issues a single query with no per-item
// fan-out. `health` is deliberately THIN (D-026: no full health strip re-computed
// here) — just the cheap leads-active count.
export interface ChiefOrgLead {
  profile: AgentProfile
  /** The lead's most recent agent_run that reached a run (has run_id), else null. */
  latestRun: Run | null
  /** That run's events (bounded) — the source the sub-agent tree is derived from. */
  events: AgentEvent[]
  /** The lead's recent activations (bounded). */
  wakes: AgentRun[]
}

export interface ChiefOrgHealth {
  leadsActive: number
}

export interface ChiefOrgPayload {
  chief: AgentProfile | null
  leads: ChiefOrgLead[]
  /** The Chief's own recent activations (bounded) — the autonomous-wake history. */
  chiefWakes: AgentRun[]
  /** Recent assignments across runs — the Objectives panel source. */
  assignments: Assignment[]
  health: ChiefOrgHealth
  /** Count of K→Chief delegations (chief activations with trigger='delegation') — the
   *  K-tier edge count the whole-org tree (user → K → Chief → …) renders. Optional so an
   *  older payload without it still builds a tree (fullOrgToDelegationTree defaults to 0). */
  kDelegations?: number
}

// ─── Orchestrators roster (GET /api/orchestrators — P5.3a) ──────────────────
// The slim roster read behind the Orchestrators page: one bounded scan per lead
// yields a SLIM entry (no per-lead delegate-events fetch — that is the detail
// view's ChiefOrgLead, reused as the detail wire type). Assembled server-side
// (core/src/routes/orchestrators.ts) so the page issues a single batched query.
export interface OrchestratorRosterEntry {
  profile: AgentProfile
  /** The lead's most recent agent_run that reached a run (has run_id), else null. */
  latestRun: Run | null
  /** True when latestRun is in a non-terminal (live) state. */
  live: boolean
  /** Count of the lead's recent activations (bounded by the per-lead scan). */
  wakes: number
}

export interface OrchestratorRosterPayload {
  leads: OrchestratorRosterEntry[]
  /** Count of leads whose latest run is live. */
  activeLeads: number
}

// A GitHub issue projected from `gh issue list --json number,title,state,url`.
export const IssueInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
})
export type IssueInfo = z.infer<typeof IssueInfoSchema>

// ─── PR creation ─────────────────────────────────────────────────────────────

export const CreatePrOptsSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().max(65535).default(''),
  head: z.string().min(1).max(255),
  base: z.string().min(1).max(255),
})
export type CreatePrOpts = z.infer<typeof CreatePrOptsSchema>

// ─── Skill/Hook/Workflow Registry ────────────────────────────────────────────

export const SkillSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  type: z.enum(['skill', 'hook', 'workflow']),
  source: z.string().min(1).max(2000),
  triggerType: z.enum(['manual', 'schedule', 'event']),
  schedule: z.string().nullable().optional(),
  eventTrigger: z.string().nullable().optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
})
export type Skill = z.infer<typeof SkillSchema>

// Shared field constraints so create and update agree on the same bounds
// (don't duplicate the limits — a single source of truth keeps them in sync).
const skillName = z.string().min(1).max(255)
const skillDescription = z.string().max(2000)
const skillSource = z.string().min(1).max(2000)

export const CreateSkillSchema = z.object({
  name: skillName,
  description: skillDescription.optional(),
  type: z.enum(['skill', 'hook', 'workflow']),
  source: skillSource,
  triggerType: z.enum(['manual', 'schedule', 'event']),
  schedule: z.string().nullable().optional(),
  eventTrigger: z.string().nullable().optional(),
})
export type CreateSkill = z.infer<typeof CreateSkillSchema>

// PATCH /api/skills/:id body — only the mutable fields, all optional (partial
// update). `name`/`description`/`source` reuse the create-time bounds above so a
// PATCH can never store a value POST would have rejected.
export const UpdateSkillSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: z.string().nullable().optional(),
    eventTrigger: z.string().nullable().optional(),
    name: skillName.optional(),
    description: skillDescription.optional(),
    source: skillSource.optional(),
  })
  .strict()
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>

// A single eval-harness test of a skill — pass/fail verdict plus regression flag
// (was-pass-now-fail vs the prior completed eval baseline).
export const SkillEvalStatusSchema = z.enum(['pending', 'pass', 'fail'])
export const SkillEvalSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  runId: z.string().nullable(),
  status: SkillEvalStatusSchema,
  regression: z.boolean(),
  baselineEvalId: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
})
export type SkillEval = z.infer<typeof SkillEvalSchema>

// ─── Routing stats ───────────────────────────────────────────────────────────
// Per-(provider,model) outcome aggregates powering the routing dashboard.

export const RoutingModelStatSchema = z.object({
  provider: z.string(),
  model: z.string(),
  runs: z.number().int(),
  successRate: z.number(),   // done / terminal-count, 0..1 (0 if no terminal runs)
  avgCostUsd: z.number(),    // mean over runs with cost_usd > 0 (0 if none)
  totalCostUsd: z.number(),
  avgLatencyMs: z.number(),  // mean ended_at - created_at over completed runs (0 if none)
})
export type RoutingModelStat = z.infer<typeof RoutingModelStatSchema>

export const RoutingStatsSchema = z.object({
  generatedAt: z.number(),
  totalRuns: z.number().int(),
  groups: z.array(RoutingModelStatSchema), // sorted by runs desc, then provider+model asc
  recommendation: z.string(),
})
export type RoutingStats = z.infer<typeof RoutingStatsSchema>

// ─── Settings: provider / auth status ────────────────────────────────────────
// GET /api/status — provider availability + harness auth posture for the Settings
// page. NEVER carries the token value or any secret: tokenSource is the *origin*
// ('env' vs 'generated'/persisted), not the credential.

export const StatusSchema = z.object({
  claude: z.object({
    available: z.boolean(),
    version: z.string().optional(),
  }),
  ollama: z.object({
    enabled: z.boolean(),
    reachable: z.boolean(),
    baseUrl: z.string(),
    model: z.string(),
  }),
  github: z.object({
    authenticated: z.boolean(),
    user: z.string().optional(),
  }),
  auth: z.object({
    // 'env' = HARNESS_TOKEN override; 'generated' = generated/persisted on first run.
    tokenSource: z.enum(['env', 'generated']),
    host: z.string(),
    loopbackOnly: z.boolean(),
    terminalEnabled: z.boolean(),
  }),
  voice: z.object({
    enabled: z.boolean(),
    reachable: z.boolean(),
    baseUrl: z.string(),
    model: z.string(),
  }),
})
export type Status = z.infer<typeof StatusSchema>

// PUT /api/system-prompt body — replaces only the human-editable region of the
// repo-root CLAUDE.md. Schema-locked: extra keys / oversize → 400.
export const SystemPromptBodySchema = z
  // .max() bounds by JS string length (UTF-16 code units / characters), not bytes — on-disk byte size may be larger for multi-byte content.
  .object({ md: z.string().max(200_000) })
  .strict()
export type SystemPromptBody = z.infer<typeof SystemPromptBodySchema>

// ─── Delegation workflow definition ──────────────────────────────────────────
// Static, hand-authored description of the harness delegation loop — the single
// source of truth both the web UI (Workflows view) and any server-side consumer
// import. It mirrors core's buildDelegationPrompt + CLAUDE.md "Delegation loop for
// code waves"; it is a plain constant (not a zod schema) like KNOWN_MODELS, since
// it is fixed content, not validated input. Descriptions state each role's
// responsibility — the orchestrator authors its sub-prompts ad hoc, so this never
// claims a role is handed a canned prompt string.

export interface WorkflowRole {
  /** Stable id; edges reference roles by this. */
  id: string
  /** Human label for the diagram box. */
  label: string
  /** Read-only responsibility shown when the role is selected. */
  description: string
}

export interface WorkflowEdge {
  /** Source role id. */
  from: string
  /** Target role id. */
  to: string
  /** Optional connector label (e.g. "fixes"). */
  label?: string
}

export interface WorkflowDefinition {
  roles: WorkflowRole[]
  edges: WorkflowEdge[]
}

/** The harness code-wave delegation loop. */
export const DELEGATION_WORKFLOW: WorkflowDefinition = {
  roles: [
    {
      id: 'orchestrator',
      label: 'Orchestrator',
      description:
        'Owns the wave. Dispatched via buildDelegationPrompt to address a batch of selected todos, the orchestrator spawns one sub-agent per role instead of doing the work in a single context, applies the reviewers’ fixes, reports progress through the workflow status-write tools, and ships ONE reviewable commit / PR for the whole batch — never a PR per todo, and never a push to the default branch.',
    },
    {
      id: 'implementer',
      label: 'Implementer',
      description:
        'Carries out the wave’s code changes against the spec in a focused context, then hands its output to the reviewers.',
    },
    {
      id: 'spec-review',
      label: 'Spec review',
      description:
        'Reviews the implementer’s output against the wave spec: does the change do what was asked, and nothing more? Runs every wave, no exceptions, and reports fixes back to the controller.',
    },
    {
      id: 'quality-review',
      label: 'Quality review',
      description:
        'Reviews the implementer’s output for code quality, simplicity, and regressions. Runs every wave, no exceptions, and reports fixes back to the controller.',
    },
  ],
  edges: [
    { from: 'orchestrator', to: 'implementer', label: 'delegates' },
    { from: 'implementer', to: 'spec-review', label: 'review' },
    { from: 'implementer', to: 'quality-review', label: 'review' },
    { from: 'spec-review', to: 'orchestrator', label: 'fixes' },
    { from: 'quality-review', to: 'orchestrator', label: 'fixes' },
  ],
}

// ─── Named workflow definitions (P5.3b, D-047) ───────────────────────────────
// DISTINCT from `WorkflowDefinition` above (that is the roles+edges DIAGRAM type for
// the D-016 viz). `NamedWorkflow` is the DB-backed, operator-editable workflow TEMPLATE:
// a name, an ordered role list, a prompt scaffold (rendered with the todo checklist at
// dispatch), and a cross_project flag (execution deferred — D-012/D-026 posture).
export interface NamedWorkflow {
  id: string
  name: string
  roles: WorkflowRole[]
  /** The delegation-prompt template; `{{CHECKLIST}}` is replaced with the numbered todo list. */
  promptScaffold: string
  /** Reserved: may this workflow reach outside the current project? Execution deferred. */
  crossProject: boolean
  createdAt: number
}

// ─── K front door (P5.1c — "talk to K") ─────────────────────────────────────
// The route surfaced when composing a message to K. `routeForMessage` is a shared,
// deterministic PREVIEW so the client and server agree on the likely hand-up before
// send — K's runtime tool/hand-up decision at execution time is AUTHORITATIVE.

export const KRouteTargetSchema = z.enum([
  'logistics',
  'chief',
  'frontend',
  'backend',
  'systems',
  'security',
  'network',
])
export type KRouteTarget = z.infer<typeof KRouteTargetSchema>

export const KRouteSchema = z.object({
  target: KRouteTargetSchema,
  label: z.string(),
  escalates: z.boolean(),
})
export type KRoute = z.infer<typeof KRouteSchema>

/** target → human label, defined once so client + server render identically. */
const K_ROUTE_LABELS: Record<KRouteTarget, string> = {
  logistics: 'K handles directly',
  chief: 'Chief',
  frontend: 'Chief → Frontend Lead',
  backend: 'Chief → Backend Lead',
  systems: 'Chief → Systems Lead',
  security: 'Chief → Security Lead',
  network: 'Chief → Network Lead',
}

/** Ordered lead rules — first match wins. Kept as a testable array (not a switch). */
const K_ROUTE_RULES: ReadonlyArray<{ target: KRouteTarget; re: RegExp }> = [
  { target: 'frontend', re: /\b(frontend|front-end|ui|react|css|component|styling|tailwind)\b/ },
  { target: 'backend', re: /\b(backend|back-end|api|endpoint|server|database|\bdb\b|sql)\b/ },
  { target: 'systems', re: /\b(systems?|infra|infrastructure|build|ci|pipeline|deploy)\b/ },
  { target: 'security', re: /\b(security|auth|vulnerab\w*|cve|exploit|secret|credential)\b/ },
  { target: 'network', re: /\b(network|proxy|dns|socket|tls|latency)\b/ },
]

/** Generic engineering (no named lead) → hand up to the Chief. */
const K_ENGINEERING_RE = /\b(code|refactor|bug|implement|fix|feature|test|merge|\bpr\b|commit|deploy|build)\b/

/**
 * Deterministic route PREVIEW for a message to K. Lowercases the message, then in a
 * fixed priority order (frontend → backend → systems → security → network → generic
 * engineering) returns the first match; anything else K handles directly (logistics).
 *
 * This is ONLY a preview so the composer (and server) can show the likely hand-up
 * before send. K's runtime decision — which tool it reaches for, and whether it
 * actually hands up to the Chief/a lead — is AUTHORITATIVE and may differ.
 */
export function routeForMessage(message: string): KRoute {
  const m = message.toLowerCase()
  for (const rule of K_ROUTE_RULES) {
    if (rule.re.test(m)) {
      return { target: rule.target, label: K_ROUTE_LABELS[rule.target], escalates: true }
    }
  }
  if (K_ENGINEERING_RE.test(m)) {
    return { target: 'chief', label: K_ROUTE_LABELS.chief, escalates: true }
  }
  return { target: 'logistics', label: K_ROUTE_LABELS.logistics, escalates: false }
}

/** Body for POST /api/k/ask — the operator's message to K. */
export const KAskBodySchema = z.object({ message: z.string().min(1).max(20000) })
export type KAskBody = z.infer<typeof KAskBodySchema>

// ─── Durable work-items HTTP surface (operator-global) ───────────────────────
// The two DURABLE scopes an operator creates/reads over the /api/k/work-items API:
// `personal` (the operator's own list) and `org` (org-wide). The ephemeral `run`
// scope and the `project` surface are NOT creatable/listable here by design.
export const DurableWorkItemScopeSchema = z.enum(['personal', 'org'])
export type DurableWorkItemScope = z.infer<typeof DurableWorkItemScopeSchema>

/** Body for POST /api/k/work-items — create a durable operator-global work item.
 *  scope defaults to 'personal'; run/project scopes are not creatable here. */
export const KWorkItemCreateBodySchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(20000).optional(),
  scope: DurableWorkItemScopeSchema.default('personal'),
})
export type KWorkItemCreateBody = z.infer<typeof KWorkItemCreateBodySchema>

/** Body for PATCH /api/k/work-items/:id — set a durable work item's status. */
export const KWorkItemPatchBodySchema = z.object({ status: WorkItemStatusSchema })
export type KWorkItemPatchBody = z.infer<typeof KWorkItemPatchBodySchema>

/** One turn in the durable K thread (D-023: persistent identity). `runId` is the
 *  run that produced/received the turn (null until known). */
export const KThreadTurnSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'k']),
  text: z.string(),
  runId: z.string().nullable(),
  createdAt: z.number(),
})
export type KThreadTurn = z.infer<typeof KThreadTurnSchema>

/** The durable K conversation — the source of truth that survives reload. `status`
 *  is a display hint; `activeRunId` is the warm interactive run (null when cold). */
export const KThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.enum(['active', 'idle']),
  activeRunId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type KThread = z.infer<typeof KThreadSchema>

/** Result of POST /api/k/ask. `warm` = true when the message continued a live
 *  interactive run; false when a fresh run was started (seeded from the thread).
 *  `agentRunId` is the agent_runs tracking id (null on the warm path). */
export const KAskResultSchema = z.object({
  kThreadId: z.string(),
  agentRunId: z.string().nullable(),
  runId: z.string(),
  route: KRouteSchema,
  warm: z.boolean(),
})
export type KAskResult = z.infer<typeof KAskResultSchema>
