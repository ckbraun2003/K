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

export const WorkItemSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  status: WorkItemStatusSchema,
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
