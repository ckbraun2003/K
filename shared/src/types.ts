import { z } from 'zod'

// ─── E-11 unified status taxonomy (P0) ───────────────────────────────────────
// THREE ORTHOGONAL AXES replacing per-surface ad-hoc status vocabularies:
//   state     — WHERE the entity is in its lifecycle;
//   attention — WHAT (if anything) it needs from the operator;
//   health    — HOW WELL it is going / ended.
// Legacy status strings (RunStatus, AgentRunStatus, …) remain the STORAGE and
// wire discriminators; the canonicalize*() mappers (end of this file) derive
// the canonical triple at the emit boundary (core events.ts) and the render
// boundary (web lib/status.ts) — ONE mapping, shared, so they cannot drift.
// P0 adopts this on the Runs + Chief surfaces only; the full sweep is P4.
export const EntityStateSchema = z.enum(['idle', 'queued', 'running', 'waiting', 'done', 'failed', 'stopped'])
export type EntityState = z.infer<typeof EntityStateSchema>

export const AttentionSchema = z.enum(['none', 'input_needed', 'review_needed', 'blocked'])
export type Attention = z.infer<typeof AttentionSchema>

export const HealthSchema = z.enum(['ok', 'degraded', 'broken', 'unknown'])
export type Health = z.infer<typeof HealthSchema>

export const CanonicalStatusSchema = z.object({
  state: EntityStateSchema,
  attention: AttentionSchema,
  health: HealthSchema,
})
export type CanonicalStatus = z.infer<typeof CanonicalStatusSchema>

// ─── Run ────────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_input', // non-terminal: an interactive run finished a turn and is waiting
                    // for the operator's next message (stdin held open). Swept to
                    // 'interrupted' at boot like running/queued (the child can't survive).
  'awaiting_plan', // non-terminal: a plan-gated one-shot finished its PLAN TURN and the
                   // process EXITED; the run waits for operator approval. Unlike
                   // awaiting_input (live process on stdin) this park is process-DEAD and
                   // RESUMABLE across reboots: worktree + per-run config dir (CLI session
                   // state) are preserved and approve --resumes cli_session_id (D-079).
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
  // The Claude CLI session id parsed from the run's stream-json init line
  // (P0 Lane B — E-22 follow-up groundwork). Absent until the init line is
  // seen; always absent for ollama runs.
  cliSessionId: z.string().optional(),
  // Canonical E-11 triple DERIVED from `status` at the emit boundary
  // (core events.ts::emitRunUpdate attaches it to every run_update). Optional:
  // REST payloads may omit it — clients re-derive via canonicalizeRunStatus.
  canonical: CanonicalStatusSchema.optional(),
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
  'status',      // synthetic: queued | running | awaiting_input | awaiting_plan | done | killed
  'checkpoint',  // synthetic: a k-checkpoint worktree snapshot landed (P0 Lane B — raw carries {sha,tree,ref,wave})
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
  // impressive-wave W0.9 (BE-1 contract, DB v13) — both optional so pre-v13
  // rows and older callers keep parsing: projectId null/absent = harness-scope;
  // origin absent reads as 'compiled' (legacy compiled rows).
  projectId: z.string().nullable().optional(),
  origin: z.enum(['compiled', 'scanned']).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

// ─── Project ────────────────────────────────────────────────────────────────
// A registry entry: local git repo + GitHub remote managed by the harness.
// Invariants (enforced by verification): GitHub remote, docs/bible/, CI workflows.

// ─── VerifyRecipe (E-04 groundwork, P0) ──────────────────────────────────────
// Operator-authored per-project verification recipe, stored as JSON in
// projects.verify_recipe (SCHEMA_VERSION 8). P0 lands ONLY the contract + the
// column; the runner + badge UI are P1 (E-04).
export const VerifyRecipeSchema = z.object({
  // Ordered gate commands, each run from the project root (a shell string).
  commands: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        run: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
  // Per-command timeout; the P1 runner picks the default when absent.
  timeoutMs: z.number().int().positive().optional(),
})
export type VerifyRecipe = z.infer<typeof VerifyRecipeSchema>

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  localPath: z.string(),               // absolute path to the repo on disk
  githubRemote: z.string().optional(), // "owner/repo"
  workspaceManaged: z.boolean().default(false), // true if harness cloned it
  bibleDir: z.string().default('docs/bible'),
  // The repo's real default branch (e.g. 'main'/'master'), detected + persisted at
  // registration/clone. Optional: pre-migration rows read back undefined and callers
  // fall back to a heuristic. Powers the PR-base default (W4 follow-up).
  defaultBranch: z.string().optional(),
  // Operator-authored verify recipe (E-04 groundwork). Optional: a NULL
  // column (or a malformed stored value) reads back as absent.
  verifyRecipe: VerifyRecipeSchema.optional(),
  // E-06: auto-merge a run's PR when K publishes a green k/verify status AND the
  // PR's checks read green. Default OFF (absent/false) — one-click merge only.
  autoMerge: z.boolean().optional(),
  healthScore: z.number().min(0).max(100).optional(),
  lastVerifiedAt: z.number().optional(), // unix ms
  // derived at read time (never persisted) — true when localPath no longer exists
  // on disk, so the UI can badge the project and the GitHub poller skips it.
  pathMissing: z.boolean().optional(),
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
  // null = INSUFFICIENT SIGNAL: no dimension could be measured (e.g. a brand-new
  // onboarded project — scaffold CI never ran, no coverage, bible still a scaffold).
  // The health score prorates over MEASURED dimensions only (verify.ts).
  score: z.number().min(0).max(100).nullable(),
  findings: z.array(FindingSchema).default([]),
  fixesApplied: z.array(z.string()).default([]),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  // Per-factor weighted score components (mirrors verify.ts HealthBreakdown). A null
  // component = that dimension was UNMEASURED (excluded from the score), not a demerit.
  // Optional so reports persisted before this field still validate.
  breakdown: z
    .object({
      ci: z.number().nullable(),
      coverage: z.number().nullable(),
      bible: z.number().nullable(),
      findings: z.number().nullable(),
    })
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

// 'lead' groups a run under the ORCHESTRATOR (discipline-lead) profile that ran it —
// resolved from the run's latest agent_runs activation whose profile is tier
// 'orchestrator'. A run with no orchestrator activation (a plain UI run, a K/Chief
// run) has no lead and groups under 'unassigned' so window cost is CONSERVED (every
// run lands in exactly one bucket), never silently dropped (W9b F-084).
export const TimeseriesGroupBySchema = z.enum(['project', 'model', 'lead'])
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
  // PR head branch (P2 E-06: matches k-review/<runId8> to link a PR to its run). Optional: pre-P2 github_cache payloads lack it.
  headRefName: z.string().optional(),
})
export type PrInfo = z.infer<typeof PrInfoSchema>

export const CiRunInfoSchema = z.object({
  id: z.number(),
  workflow: z.string(),
  branch: z.string(),
  status: z.string(),              // completed | in_progress | queued
  conclusion: z.string().nullable(), // success | failure | … | null while running
  createdAt: z.string(),
  // INT.2 FE IN-2: wall-clock duration (updatedAt - createdAt) for a COMPLETED run only;
  // absent while queued/in_progress (no end timestamp yet) — never a fabricated 0.
  durationMs: z.number().optional(),
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
// `workflowId` optionally names a NamedWorkflow whose scaffold seeds the prompt
// (C2 "Run this workflow"); omitted = the built-in code-wave scaffold.
export const DispatchTasksBodySchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(50),
  workflowId: z.string().min(1).optional(),
})
export type DispatchTasksBody = z.infer<typeof DispatchTasksBodySchema>

// ─── P1 Trust Core (E-01/E-03/E-04/E-07) ─────────────────────────────────────
// The W0-frozen wire contracts for the Review Deck, replay/rewind, the verify
// badge, and the impact panel. Diffs from BOTH producers (checkpoint-chain
// `git diff` and `gh pr diff`) normalize to the ONE DiffPayload shape.

export const DiffLineSchema = z.object({
  kind: z.enum(['ctx', 'add', 'del']),
  text: z.string(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
})
export type DiffLine = z.infer<typeof DiffLineSchema>

export const DiffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(DiffLineSchema),
})
export type DiffHunk = z.infer<typeof DiffHunkSchema>

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),        // renamed files only
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  binary: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  hunks: z.array(DiffHunkSchema),
})
export type DiffFile = z.infer<typeof DiffFileSchema>

export const DiffPayloadSchema = z.object({
  // 'checkpoint' = derived from the run's k-checkpoint chain (durable — survives
  // worktree removal; mid-run it lags the live tree by at most one wave);
  // 'pr' = `gh pr diff` for PR-backed entities on the PRs & CI mount.
  source: z.enum(['checkpoint', 'pr']),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  files: z.array(DiffFileSchema),
  truncated: z.boolean(),                // payload was cut at the parser byte cap
})
export type DiffPayload = z.infer<typeof DiffPayloadSchema>

export const ReviewCommentSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  file: z.string(),
  line: z.number().int().nullable(),     // new-side (or old-side) line anchor; null = file-level
  side: z.enum(['old', 'new']),
  body: z.string(),
  status: z.enum(['draft', 'sent', 'resolved']),
  createdAt: z.number(),
})
export type ReviewComment = z.infer<typeof ReviewCommentSchema>

export const CreateReviewCommentBodySchema = z.object({
  file: z.string().min(1).max(1000),
  line: z.number().int().positive().nullable().optional(),
  side: z.enum(['old', 'new']).default('new'),
  body: z.string().min(1).max(10000),
})
export type CreateReviewCommentBody = z.infer<typeof CreateReviewCommentBodySchema>

export const UpdateReviewCommentBodySchema = z
  .object({
    body: z.string().min(1).max(10000).optional(),
    status: z.enum(['draft', 'sent', 'resolved']).optional(),
  })
  .strict()
  .refine(v => v.body !== undefined || v.status !== undefined, { message: 'provide body or status' })
export type UpdateReviewCommentBody = z.infer<typeof UpdateReviewCommentBodySchema>

export const RequestChangesBodySchema = z.object({
  model: z.string().min(1).max(200).optional(),
})
export type RequestChangesBody = z.infer<typeof RequestChangesBodySchema>

export const RequestChangesResultSchema = z.object({
  run: RunSchema,
  commentsSent: z.number().int(),
})
export type RequestChangesResult = z.infer<typeof RequestChangesResultSchema>

export const ApproveRunBodySchema = z.object({
  title: z.string().min(1).max(255).optional(),
  body: z.string().max(65535).optional(),
  base: z.string().min(1).max(255).optional(),
})
export type ApproveRunBody = z.infer<typeof ApproveRunBodySchema>

export const ApproveRunResultSchema = z.object({
  branch: z.string(),
  pr: z.object({ number: z.number().int(), url: z.string(), title: z.string(), state: z.string() }),
})
export type ApproveRunResult = z.infer<typeof ApproveRunResultSchema>

// E-03 — one persisted checkpoint event, projected for the scrubber/rewind UI.
export const RunCheckpointSchema = z.object({
  sha: z.string(),
  tree: z.string(),
  ref: z.string(),
  wave: z.number().int(),
  seq: z.number().int(),                 // the checkpoint event's seq (scrubber position)
  ts: z.number(),
})
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>

export const RewindBodySchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i, 'must be a full 40-char commit sha'),
  prompt: z.string().min(1).max(100000),
  model: z.string().min(1).max(200).optional(),
})
export type RewindBody = z.infer<typeof RewindBodySchema>

// E-04 — structured verify result (the badge chip's data).
export const VerifyCommandResultSchema = z.object({
  label: z.string(),
  run: z.string(),
  exitCode: z.number().int().nullable(), // null = spawn failure / timeout kill
  ok: z.boolean(),
  durationMs: z.number(),
  outputTail: z.string(),                // last 2000 chars of combined output
})
export type VerifyCommandResult = z.infer<typeof VerifyCommandResultSchema>

export const VerifyScopeSchema = z.object({
  files: z.array(z.string()),            // changed files (checkpoint base → final)
  symbols: z.number().int().nullable(),  // indexed symbols in those files; null = graph unavailable
  indexed: z.boolean(),
})
export type VerifyScope = z.infer<typeof VerifyScopeSchema>

export const VerifyStatusSchema = z.enum(['running', 'pass', 'fail', 'skipped', 'error'])
export type VerifyStatus = z.infer<typeof VerifyStatusSchema>

export const VerifyResultSchema = z.object({
  runId: z.string().uuid(),
  status: VerifyStatusSchema,
  reason: z.string().nullable(),         // skipped/error explanation; null otherwise
  commands: z.array(VerifyCommandResultSchema),
  scope: VerifyScopeSchema.nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
})
export type VerifyResult = z.infer<typeof VerifyResultSchema>

/** PATCH /api/projects/:id/verify-recipe — null clears the recipe. */
export const UpdateVerifyRecipeBodySchema = z.object({
  recipe: VerifyRecipeSchema.nullable(),
})
export type UpdateVerifyRecipeBody = z.infer<typeof UpdateVerifyRecipeBodySchema>

// E-07 — blast radius for a run's changed files (graph.json-derived, offline).
export const ImpactSymbolSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  dependents: z.number().int(),          // inbound graph edges (direct dependents)
})
export type ImpactSymbol = z.infer<typeof ImpactSymbolSchema>

export const ImpactFileSchema = z.object({
  file: z.string(),
  symbols: z.array(ImpactSymbolSchema),
})
export type ImpactFile = z.infer<typeof ImpactFileSchema>

export const ImpactRiskSchema = z.enum(['low', 'medium', 'high'])
export type ImpactRisk = z.infer<typeof ImpactRiskSchema>

export const RunImpactPayloadSchema = z.object({
  indexed: z.boolean(),
  projectId: z.string().nullable(),
  files: z.array(ImpactFileSchema),
  totalSymbols: z.number().int(),
  totalDependents: z.number().int(),
  risk: ImpactRiskSchema.nullable(),     // null = no symbols matched / unindexed
})
export type RunImpactPayload = z.infer<typeof RunImpactPayloadSchema>

// ─── P2 Human Gates (E-02/E-05/E-06/E-19) ────────────────────────────────────
// The W0-frozen wire contracts for the Plan Gate, the Approvals Inbox, merge
// gating, and notifications phase 1.

// E-02 — the structured checklist plan the scaffold demands (steps/files/risk).
export const PlanStepSchema = z.object({
  title: z.string().min(1).max(500),
  detail: z.string().max(4000).optional(),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const PlanDocSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(50),
  files: z.array(z.string().min(1).max(1000)).max(200),
  risk: z.enum(['low', 'medium', 'high']),
  notes: z.string().max(10000).optional(),
})
export type PlanDoc = z.infer<typeof PlanDocSchema>

// One CURRENT plan per run (run_plans row). plan is null when the model's plan
// turn produced no parseable fenced json — raw always carries the turn text, so
// the operator still sees (and can approve) a degraded plan honestly.
export const RunPlanSchema = z.object({
  runId: z.string().uuid(),
  plan: PlanDocSchema.nullable(),
  raw: z.string(),
  edited: z.boolean(),
  profileId: z.string().nullable(),      // dispatching profile; null = default orchestrator
  createdAt: z.number(),
  updatedAt: z.number(),
  approvedAt: z.number().nullable(),
})
export type RunPlan = z.infer<typeof RunPlanSchema>

/** PATCH /api/runs/:id/plan — last-wins structured edit (sets edited=true). */
export const UpdateRunPlanBodySchema = z.object({ plan: PlanDocSchema }).strict()
export type UpdateRunPlanBody = z.infer<typeof UpdateRunPlanBodySchema>

// E-19 — the notify engine's event keys.
export const NotificationEventKeySchema = z.enum([
  'run_awaiting_input', 'run_awaiting_plan', 'run_review_ready', 'run_failed', 'verify_fail',
  'memory_saved',
])
export type NotificationEventKey = z.infer<typeof NotificationEventKeySchema>

// NOTE (web): alias this type as `KNotification` in web imports — the browser
// global `Notification` (the Notification API constructor) must stay reachable.
export const NotificationSchema = z.object({
  id: z.string().uuid(),
  eventKey: NotificationEventKeySchema,
  title: z.string(),
  body: z.string().nullable(),
  runId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
})
export type Notification = z.infer<typeof NotificationSchema>

export const NotificationRuleSchema = z.object({
  eventKey: NotificationEventKeySchema,
  inapp: z.boolean(),
  browser: z.boolean(),
})
export type NotificationRule = z.infer<typeof NotificationRuleSchema>

export const UpdateNotificationRuleBodySchema = z
  .object({ inapp: z.boolean().optional(), browser: z.boolean().optional() })
  .strict()
  .refine(v => v.inapp !== undefined || v.browser !== undefined, { message: 'provide inapp or browser' })
export type UpdateNotificationRuleBody = z.infer<typeof UpdateNotificationRuleBodySchema>

// E-14 — the collector that produced a proposal. Declared ABOVE the inbox union
// (BLOCKER 3): InboxItemSchema is a z.discriminatedUnion evaluated eagerly at module
// load, and its `proposal` member references this — so it must resolve first.
export const ProposalSourceSchema = z.enum(['ci_failed', 'verify_finding', 'open_issue', 'stale_bible'])
export type ProposalSource = z.infer<typeof ProposalSourceSchema>

// E-05 — the typed inbox card union. `id` is the kind-scoped stable id
// `<kind>:<entity id>`; `ts` is the sort key (park/creation/discovery time).
export const InboxItemKindSchema = z.enum([
  'plan_pending', 'input_needed', 'lesson_pending', 'mcp_trust', 'review_ready', 'proposal',
])
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>

const inboxCommon = {
  id: z.string(),
  ts: z.number(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
} as const

export const InboxItemSchema = z.discriminatedUnion('kind', [
  // actions: review/edit/approve via the plan routes (navigate to the run console)
  z.object({ ...inboxCommon, kind: z.literal('plan_pending'), runId: z.string(),
    risk: z.enum(['low', 'medium', 'high']).nullable(), steps: z.number().int().nullable(), edited: z.boolean() }),
  // actions: reply (POST /api/runs/:id/input) / end — navigate to the run console
  z.object({ ...inboxCommon, kind: z.literal('input_needed'), runId: z.string(), model: z.string() }),
  // actions: approve / reject (POST /api/memory/lessons/:id/approve|reject) — inline
  z.object({ ...inboxCommon, kind: z.literal('lesson_pending'), lessonId: z.string(), profileName: z.string().nullable() }),
  // actions: trust (POST /api/capabilities/mcp/:id/trust) / dismiss (POST /api/inbox/mcp/:id/dismiss) — inline
  z.object({ ...inboxCommon, kind: z.literal('mcp_trust'), qualifiedKey: z.string(),
    sourceKind: z.enum(['claude-user', 'claude-project']), command: z.string() }),
  // actions: open review (run console review view) / dismiss (POST /api/inbox/runs/:id/dismiss-review)
  z.object({ ...inboxCommon, kind: z.literal('review_ready'), runId: z.string(),
    verifyStatus: VerifyStatusSchema.nullable() }),
  // actions: approve (POST /api/inbox/proposals/:id/approve) / dismiss (…/dismiss) — inline
  z.object({ ...inboxCommon, kind: z.literal('proposal'), workItemId: z.string(),
    source: ProposalSourceSchema, body: z.string().nullable() }),
])
export type InboxItem = z.infer<typeof InboxItemSchema>

export const InboxCountsSchema = z.object({
  plan_pending: z.number().int(),
  input_needed: z.number().int(),
  lesson_pending: z.number().int(),
  mcp_trust: z.number().int(),
  review_ready: z.number().int(),
  proposal: z.number().int(),
})
export type InboxCounts = z.infer<typeof InboxCountsSchema>

export const InboxPayloadSchema = z.object({
  items: z.array(InboxItemSchema),   // ts DESC; review_ready capped at 20 items
  counts: InboxCountsSchema,         // TRUE (uncapped) per-kind counts
  total: z.number().int(),           // sum of counts = the needs-YOU rail badge
})
export type InboxPayload = z.infer<typeof InboxPayloadSchema>

// E-06 — one-click merge + auto-merge toggle.
export const MergePrResultSchema = z.object({ merged: z.boolean(), number: z.number().int() })
export type MergePrResult = z.infer<typeof MergePrResultSchema>

export const SetAutoMergeBodySchema = z.object({ enabled: z.boolean() }).strict()
export type SetAutoMergeBody = z.infer<typeof SetAutoMergeBodySchema>

// ─── P3 Visibility (E-08/E-09/E-13) ──────────────────────────────────────────
// The W0-frozen wire contracts for the Run Narrative card, the Org Timeline
// feed, and the measured cost lens. All read-side (no schema, no WS member).

// E-08 — deterministic verification summary (a projection of VerifyResult).
export const NarrativeVerifySchema = z.object({
  status: VerifyStatusSchema.nullable(),
  reason: z.string().nullable(),
  commandCount: z.number().int(),
})
export type NarrativeVerify = z.infer<typeof NarrativeVerifySchema>

// E-08 — the LOCAL-model bullets. `generated` is the literal true (a permanent
// "generated" label the card renders); decisions/risks are HARD-capped at 3 so a
// runaway model can never flood the deterministic card.
export const NarrativeBulletsSchema = z.object({
  decisions: z.array(z.string().min(1).max(500)).max(3),
  risks: z.array(z.string().min(1).max(500)).max(3),
  generated: z.literal(true),
  model: z.string(),
})
export type NarrativeBullets = z.infer<typeof NarrativeBulletsSchema>

// 'ok' => render bullets; 'unavailable' => Ollama unreachable/no model (omit +
// note); 'disabled' => operator turned Ollama off; 'error' => the model answered
// but unparseably (omit + note). The card NEVER blocks on any of these.
export const NarrativeBulletsStateSchema = z.enum(['ok', 'unavailable', 'disabled', 'error'])
export type NarrativeBulletsState = z.infer<typeof NarrativeBulletsStateSchema>

export const RunNarrativeSchema = z.object({
  runId: z.string().uuid(),
  goal: z.string(),
  outcome: z.object({
    status: RunStatusSchema,
    endedAt: z.number().nullable(),
    durationMs: z.number().int().nullable(),
  }),
  files: z.array(z.string()),
  verification: NarrativeVerifySchema.nullable(),
  cost: z.object({
    costUsd: z.number(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
  }),
  bullets: NarrativeBulletsSchema.nullable(),
  bulletsState: NarrativeBulletsStateSchema,
})
export type RunNarrative = z.infer<typeof RunNarrativeSchema>

// E-09 — the curated MILESTONE set the feed projects (filter chips key off these).
export const FeedKindSchema = z.enum([
  'dispatch', 'park', 'plan_gate', 'review_ready', 'pr', 'merge',
  'verify_pass', 'verify_fail', 'failure', 'done',
])
export type FeedKind = z.infer<typeof FeedKindSchema>

// One projected feed row. `runStatus` is the run's CURRENT status (a live join),
// NOT the status at event time — informational only (a timeline row can show its
// run's present state). runId/runStatus are null for notification rows with no run
// linkage. (Contract stays lean: no prompt/agent field, no `heads` on FeedPayload.)
export const FeedItemSchema = z.object({
  id: z.string(),
  kind: FeedKindSchema,
  ts: z.number(),
  runId: z.string().nullable(),
  runStatus: RunStatusSchema.nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  // INT.2 FE IN-1: billed actuals for run-derived rows (never price*token math);
  // absent/undefined for non-run rows (notif/verify/pr) that have no run cost to show.
  costUsd: z.number().optional(),
})
export type FeedItem = z.infer<typeof FeedItemSchema>

export const FeedPayloadSchema = z.object({
  items: z.array(FeedItemSchema),                          // ts DESC, capped (default 100)
  counts: z.record(FeedKindSchema, z.number().int()),      // per-kind counts across the window
  total: z.number().int(),
})
export type FeedPayload = z.infer<typeof FeedPayloadSchema>

// E-13 — measured cost roll-ups (run->lead->project->day). costUsd is billed actuals
// summed from runs.cost_usd; NO price*token math anywhere (grep-gated).
export const CostRollupBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  costUsd: z.number(),
  runs: z.number().int(),
})
export const CostRollupSchema = z.object({
  windowDays: z.number().int(),
  groupBy: z.enum(['lead', 'project', 'day']),
  buckets: z.array(CostRollupBucketSchema),
  totalCostUsd: z.number(),
})
export type CostRollup = z.infer<typeof CostRollupSchema>

// E-13 — dispatch-time "recent actuals". scope records WHICH fallback tier produced
// the numbers: the selected agent profile's recent runs, else the project's, else
// global; 'none' when even global has zero runs in the window.
export const RecentActualsScopeSchema = z.enum(['profile', 'project', 'global', 'none'])
export type RecentActualsScope = z.infer<typeof RecentActualsScopeSchema>

export const RecentActualsSchema = z.object({
  scope: RecentActualsScopeSchema,
  n: z.number().int(),
  windowDays: z.number().int(),
  medianCostUsd: z.number().nullable(),   // null iff n === 0
  p90CostUsd: z.number().nullable(),
})
export type RecentActuals = z.infer<typeof RecentActualsSchema>

// ─── Autonomy (Phase 5) ──────────────────────────────────────────────────────
// The persisted operator config that gates the whole autonomy stack (default OFF).
export const AutonomySettingsSchema = z.object({
  enabled: z.boolean(),                              // master (default false)
  proposals: z.boolean(),                            // E-14 collectors
  backlogAutoPull: z.boolean(),                      // E-15 relay
  selfHeal: z.boolean(),                             // E-18 retries
  maxConcurrency: z.number().int().min(1).max(10),   // E-15 slot cap
  orgDailyBudgetUsd: z.number().nonnegative().nullable(), // E-17 org cap (null=off)
  budgetWarnPct: z.number().min(0).max(1),           // E-17 warn threshold fraction
}).strict()
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>
export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8,
}
export const AutonomyPatchBodySchema = AutonomySettingsSchema.partial().strict()
  .refine(v => Object.keys(v).length > 0, { message: 'empty patch' })
export type AutonomyPatchBody = z.infer<typeof AutonomyPatchBodySchema>

export const ProjectBudgetPatchBodySchema = z.object({
  budgetDailyUsd: z.number().nonnegative().nullable(),
}).strict()

// E-17 — measured budget status (rolling window; NO forecasting).
export const BudgetScopeStatusSchema = z.object({
  capUsd: z.number().nullable(),
  spentUsd: z.number(),
  warnPct: z.number(),
  state: z.enum(['ok', 'warn', 'capped']),
})
export type BudgetScopeStatus = z.infer<typeof BudgetScopeStatusSchema>
export const BudgetStatusSchema = z.object({
  windowHours: z.number().int(),
  org: BudgetScopeStatusSchema,
  projects: z.array(z.object({ projectId: z.string(), projectName: z.string(), status: BudgetScopeStatusSchema })),
  generatedAt: z.number(),
})
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>

// E-18 — self-healing failure taxonomy + retry-rate series.
export const FailureClassSchema = z.enum(['transient', 'timeout', 'model_capacity', 'tooling', 'permanent', 'unknown'])
export type FailureClass = z.infer<typeof FailureClassSchema>

export const RetryRatePointSchema = z.object({ day: z.string(), runs: z.number().int(), retries: z.number().int(), rate: z.number() })
export const RetryRateSeriesSchema = z.object({ windowDays: z.number().int(), points: z.array(RetryRatePointSchema), overallRate: z.number() })
export type RetryRateSeries = z.infer<typeof RetryRateSeriesSchema>

// E-16 — a routine is a schedule-triggered skill with derived next-run + measured cost.
export const RoutineViewSchema = z.object({
  id: z.string(), name: z.string(), enabled: z.boolean(), schedule: z.string(),
  nextRunAt: z.number().nullable(), lastRunAt: z.number().nullable(),
  runs: z.number().int(), totalCostUsd: z.number(),
})
export type RoutineView = z.infer<typeof RoutineViewSchema>
export const NlToCronBodySchema = z.object({ text: z.string().min(1).max(200) }).strict()

// ─── Executable pipelines (D-119 — Pipeline Engine W0 frozen contracts) ───────
// TWO type layers: DEFINITION-TIME (`PipelineSpec`, authored + stored as JSON in
// workflow_definitions.spec) and RUNTIME (DB rows + wire views, further below). Zod
// is the type truth. Every leaf/enum schema is declared BEFORE the StageDef/WsMessage
// discriminated unions that reference it (the eager-eval rule at types.ts:636) — which
// is why this whole block sits just above the WebSocket-message union. Reuses
// FailureClassSchema (above) for retry classification and CanonicalStatusSchema (top).

// ── Definition-time (authoring) ───────────────────────────────────────────────
export const HandoffModeSchema = z.enum(['share-tree', 'branch', 'merge'])
export type HandoffMode = z.infer<typeof HandoffModeSchema>
export const EdgeWhenSchema = z.enum(['always', 'pass', 'fail', 'repair'])
export type EdgeWhen = z.infer<typeof EdgeWhenSchema>

// A stage key is a short slug — the stable id edges/repair/gates reference.
const STAGE_KEY = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/i)

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs:   z.number().int().min(0).max(600_000).default(0),
  retryOn:     z.array(FailureClassSchema).default(['transient', 'timeout', 'model_capacity']),
}).strict()
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

export const RepairRoutingSchema = z.object({
  toStage:    z.string().min(1).max(100).nullable(),   // null = hard-fail the pipeline
  maxRepairs: z.number().int().min(0).max(10).default(2),
}).strict()
export type RepairRouting = z.infer<typeof RepairRoutingSchema>

export const GatePredicateSchema = z.object({
  verifyStatus:   z.enum(['pass', 'fail']).optional(),
  maxCostUsd:     z.number().nonnegative().optional(),
  requireCleanCi: z.boolean().optional(),
  expr:           z.string().max(2000).optional(),     // SEAM — deferred eval
}).strict()
export type GatePredicate = z.infer<typeof GatePredicateSchema>

export const GateAttrSchema = z.object({
  mode:      z.enum(['declarative', 'manual', 'agent']).default('declarative'),
  predicate: GatePredicateSchema.default({}),
}).strict()
export type GateAttr = z.infer<typeof GateAttrSchema>

// Injection intelligence is DEFERRED (Phase 3) — this is the field/seam only.
export const InjectionPolicySchema = z.object({
  mode:  z.enum(['off', 'auto']).default('off'),
  hints: z.array(z.string().max(200)).max(20).default([]),
}).strict()
export type InjectionPolicy = z.infer<typeof InjectionPolicySchema>

export const HookRefSchema = z.object({
  hookId: z.string().min(1).max(200),
  when:   z.enum(['pre', 'post']).default('pre'),
}).strict()
export type HookRef = z.infer<typeof HookRefSchema>

export const PipelineHookSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('script'), file: z.string().min(1).max(200),
             timeoutSec: z.number().int().min(1).max(120).default(30) }),
  z.object({ type: z.literal('agent'), profileId: z.string(), model: z.string().nullable().default(null),
             promptScaffold: z.string().min(1), timeoutSec: z.number().int().min(1).max(600).default(120) }),
])
export type PipelineHook = z.infer<typeof PipelineHookSchema>

// Fields common to every stage kind — spread into each discriminated-union member.
const stageCommon = {
  id:        STAGE_KEY,
  label:     z.string().min(1).max(200),
  hooks:     z.array(HookRefSchema).max(20).default([]),
  injection: InjectionPolicySchema.default({}),
  retry:     RetryPolicySchema.default({}),
  repair:    RepairRoutingSchema.optional(),
} as const

// Each member is `.strict()` so an operator-authored spec with a mistyped field
// (e.g. `plangate` for `planGate`) is REJECTED rather than silently dropped +
// defaulted. Zod allows per-member strict objects inside a discriminatedUnion.
export const StageDefSchema = z.discriminatedUnion('kind', [
  z.object({ ...stageCommon, kind: z.literal('agent'),
    role: z.string().min(1).max(100), profileId: z.string().nullable().default(null),
    model: z.string().nullable().default(null), promptScaffold: z.string().min(1),
    planGate: z.boolean().default(false) }).strict(),
  z.object({ ...stageCommon, kind: z.literal('deterministic'),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('verify') }).strict(),
      z.object({ type: z.literal('command'), run: z.string().min(1).max(2000) }).strict(),
      z.object({ type: z.literal('commit') }).strict(),
      z.object({ type: z.literal('ci') }).strict(),
    ]) }).strict(),
  z.object({ ...stageCommon, kind: z.literal('gate'), gate: GateAttrSchema }).strict(),
  z.object({ ...stageCommon, kind: z.literal('hook'), hook: PipelineHookSchema }).strict(),
])
export type StageDef = z.infer<typeof StageDefSchema>

export const EdgeDefSchema = z.object({
  from: STAGE_KEY, to: STAGE_KEY,
  handoff: HandoffModeSchema.default('share-tree'),
  when: EdgeWhenSchema.default('always'),
  label: z.string().max(100).optional(),
}).strict()
export type EdgeDef = z.infer<typeof EdgeDefSchema>

export const PipelineSpecSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.number().int().min(1).default(1),
  description: z.string().max(2000).optional(),
  stages: z.array(StageDefSchema).min(1).max(50),
  edges: z.array(EdgeDefSchema).max(200),
  entry: STAGE_KEY,
  crossProject: z.boolean().default(false),
}).strict().superRefine((p, ctx) => {
  // unique stage ids; 'done' is the reserved terminal-sink edge target and may not
  // name a stage (else its id is unaddressable — every edge to it reads as the sink).
  const ids = p.stages.map(s => s.id)
  const idSet = new Set<string>()
  for (const id of ids) {
    if (id === 'done') ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'done' is reserved (the terminal edge target) and cannot be a stage id`, path: ['stages'] })
    if (idSet.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stage id: ${id}`, path: ['stages'] })
    idSet.add(id)
  }
  const has = (k: string) => idSet.has(k)
  // entry ∈ ids
  if (!has(p.entry)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `entry '${p.entry}' is not a stage id`, path: ['entry'] })
  // every edge.from ∈ ids; edge.to ∈ ids or the literal 'done' (the terminal sink). A
  // self-loop is only meaningful as a repair back-edge (when:'repair').
  p.edges.forEach((e, i) => {
    if (!has(e.from)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `edge.from '${e.from}' is not a stage id`, path: ['edges', i, 'from'] })
    if (e.to !== 'done' && !has(e.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `edge.to '${e.to}' is not a stage id or 'done'`, path: ['edges', i, 'to'] })
    if (e.from === e.to && e.when !== 'repair') ctx.addIssue({ code: z.ZodIssueCode.custom, message: `self-loop on '${e.from}' is only allowed when:'repair'`, path: ['edges', i] })
  })
  // every repair.toStage ∈ ids (null = hard-fail the pipeline, 'done' = terminal — both allowed)
  p.stages.forEach((s, i) => {
    const to = s.repair?.toStage
    if (to != null && to !== 'done' && !has(to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `repair.toStage '${to}' is not a stage id`, path: ['stages', i, 'repair', 'toStage'] })
  })
  // reachability from entry — a stage no forward/repair edge can reach can never run.
  // Repair targets fold into the adjacency (a repair-only stage is legitimately entered
  // when its source fails, so it must not be flagged as an orphan).
  if (has(p.entry)) {
    const adj = new Map<string, string[]>()
    const link = (from: string, to: string) => {
      if (to === 'done' || !has(to)) return
      const list = adj.get(from) ?? []
      list.push(to)
      adj.set(from, list)
    }
    for (const e of p.edges) link(e.from, e.to)
    for (const s of p.stages) if (s.repair?.toStage) link(s.id, s.repair.toStage)
    const seen = new Set<string>([p.entry])
    const stack = [p.entry]
    while (stack.length) {
      const cur = stack.pop()!
      for (const nxt of adj.get(cur) ?? []) if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt) }
    }
    for (const id of ids) if (!seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `stage '${id}' is unreachable from entry`, path: ['stages'] })
  }
})
export type PipelineSpec = z.infer<typeof PipelineSpecSchema>

/** Faithful lift of a legacy NamedWorkflow into an executable PipelineSpec. Today's
 *  dispatchTaskWorkflow launches exactly ONE orchestrator run (which itself spawns the
 *  role sub-agents in-context), so the honest executable form is a SINGLE `agent` stage
 *  carrying the workflow's prompt scaffold — not a multi-stage role chain (that richer
 *  lift waits until each role is its own run). `WorkflowDefinition`/`NamedWorkflow`/
 *  `DELEGATION_WORKFLOW` stay untouched. (The `NamedWorkflow` interface is declared later
 *  in this file — a type-only forward reference, which TypeScript hoists.) */
export function namedWorkflowToPipeline(nw: NamedWorkflow): PipelineSpec {
  return PipelineSpecSchema.parse({
    name: nw.name,
    version: 1,
    stages: [{
      kind: 'agent',
      id: 'orchestrator',
      label: 'Orchestrator',
      role: 'orchestrator',
      // prompt_scaffold is NOT NULL but may be '' — the agent stage requires min(1),
      // so normalize an empty scaffold to a minimal instruction rather than throwing.
      promptScaffold: nw.promptScaffold.trim() || `Run the "${nw.name}" workflow.`,
    }],
    edges: [],
    entry: 'orchestrator',
    crossProject: nw.crossProject,
  })
}

// ── Runtime wire views (DB rows → API/WS projections) ─────────────────────────
export const PipelineRunStatusSchema  = z.enum(['running', 'completed', 'failed', 'cancelled'])
export type PipelineRunStatus = z.infer<typeof PipelineRunStatusSchema>
export const PipelineStageStatusSchema = z.enum(['pending', 'dispatched', 'running', 'awaiting_gate', 'passed', 'failed', 'skipped'])
export type PipelineStageStatus = z.infer<typeof PipelineStageStatusSchema>

export const PipelineStageRunSchema = z.object({
  id: z.string(), pipelineRunId: z.string(), stageKey: z.string(), kind: z.string(),
  status: PipelineStageStatusSchema, canonical: CanonicalStatusSchema.optional(),
  runId: z.string().nullable(), attempt: z.number().int(), maxAttempts: z.number().int(),
  repairs: z.number().int(), costUsd: z.number().nullable(),
  failureClass: FailureClassSchema.nullable(), gateNote: z.string().nullable(),
  baseCommit: z.string().nullable(), resultCommit: z.string().nullable(),
  startedAt: z.number().nullable(), completedAt: z.number().nullable(),
})
export type PipelineStageRun = z.infer<typeof PipelineStageRunSchema>

export const PipelineEdgeViewSchema = z.object({
  from: z.string().nullable(), to: z.string(), handoff: HandoffModeSchema, when: EdgeWhenSchema,
})
export type PipelineEdgeView = z.infer<typeof PipelineEdgeViewSchema>

export const PipelineRunSchema = z.object({
  id: z.string(), definitionId: z.string().nullable(), projectId: z.string().nullable(),
  title: z.string(), status: PipelineRunStatusSchema,
  createdAt: z.number(), updatedAt: z.number(), completedAt: z.number().nullable(),
})
export type PipelineRun = z.infer<typeof PipelineRunSchema>

export const PipelineRunViewSchema = z.object({
  run: PipelineRunSchema, stages: z.array(PipelineStageRunSchema), edges: z.array(PipelineEdgeViewSchema),
})
export type PipelineRunView = z.infer<typeof PipelineRunViewSchema>

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
  // E-04: a run's verify result changed (running → pass/fail/skipped/error).
  z.object({ type: z.literal('verify_update'), result: VerifyResultSchema }),
  // E-19: a notification fired (rules-gated). `browser` = the matching rule wants
  // a browser Notification raised client-side. Transient on the wire; the in-app
  // center reads the durable notifications table.
  z.object({ type: z.literal('notification'), notification: NotificationSchema, browser: z.boolean() }),
  // Knowledge-graph build state transition (building → ready/error) + reindex marks
  z.object({ type: z.literal('graph_update'), projectId: z.string(), meta: ProjectGraphMetaSchema }),
  // A task-workflow run finalized (F-076) — a nudge to REVIEW + CLOSE the tasks it locked
  // to in_progress (the harness never auto-closes them — D-012). Transient, not persisted.
  z.object({
    type: z.literal('workflow_complete'),
    workflowRunId: z.string(),
    projectId: z.string(),
    status: z.enum(['completed', 'failed']),
    taskIds: z.array(z.string()),
  }),
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
  // Capability catalog changed (rescan completed / overlay toggled) — a nudge to
  // invalidate ['capabilities'] queries. Transient, not persisted (D-069).
  z.object({ type: z.literal('capabilities_update'), scannedAt: z.number() }),
  // E-14: a proposal was created/approved/dismissed — nudge ['inbox'] invalidation.
  z.object({ type: z.literal('proposal_update') }),
  // E-17: measured budget status changed (a dispatch spent, or a cap moved).
  z.object({ type: z.literal('budget_update'), status: BudgetStatusSchema }),
  // E-18: a failed run was auto-retried.
  z.object({ type: z.literal('run_retried'), originalRunId: z.string(), retryRunId: z.string(), failureClass: FailureClassSchema }),
  // D-119: a pipeline stage transitioned (dispatch/pass/fail/gate) — carries the full
  // refreshed run view so the live DAG re-renders. `stageId` names the transitioned
  // stage (null for run-level transitions: creation/finalize).
  z.object({ type: z.literal('pipeline_update'), pipelineRunId: z.string(),
             stageId: z.string().nullable(), view: PipelineRunViewSchema }),
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
  // H8 (opt-in): start the run's worktree from the source repo's UNCOMMITTED
  // tracked+staged changes instead of clean committed HEAD. Default false/absent →
  // byte-identical clean-HEAD checkout. Untracked/ignored files are NOT carried.
  carryWorkingTree: z.boolean().optional(),
  // E-02: gate this dispatch behind an operator-approved plan turn. Absent = the
  // tier default (agent_profiles.plan_gate of the resolving profile) applies.
  planGate: z.boolean().optional(),
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
  // Which NamedWorkflow TEMPLATE the run was dispatched from (workflow_definitions id),
  // and — when resolvable — that template's name. Null for a default (code-wave) dispatch
  // that named no template. Optional so older payloads/fixtures without them still parse.
  workflowId: z.string().nullable().optional(),
  workflowName: z.string().nullable().optional(),
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
  // null = "use the runtime Claude default (config-store claudeDefaultModel) at
  // dispatch time"; a string = an explicit per-profile override (a KNOWN_MODELS id).
  defaultModel: z.string().nullable(),
  allowedTools: z.array(z.string()), // claude --allowedTools allowlist (tier-gated)
  mcpServers: z.array(z.string()), // tier-scoped MCP servers this profile mounts
  skills: z.array(z.string()), // skill dir names this profile mounts
  // E-02 tier default: dispatches resolved through this profile are plan-gated
  // unless the dispatch body says otherwise. Optional — absent = false.
  planGate: z.boolean().optional(),
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

// ─── UserMemory (operator memory, UI Simplification) ───────────────────────
// The operator's own durable memory store — distinct from Lesson (agent memory,
// layer A, gated by accept/reject). A UserMemory is saved directly (by the
// operator or K's memory_save tool), no review gate.
export const UserMemorySchema = z.object({
  id: z.string(),
  content: z.string().min(1).max(2000),
  sourceThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type UserMemory = z.infer<typeof UserMemorySchema>

export const UserMemoryCreateBodySchema = z.object({ content: z.string().min(1).max(2000) }).strict()
export const UserMemoryPatchBodySchema = z.object({ content: z.string().min(1).max(2000) }).strict()

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

/** Payload of GET /api/k/schedule — the K-home Schedule card's one batched read:
 *  upcoming calendar events (soonest first) + pending reminders (including overdue —
 *  an overdue reminder is the most important thing to show, not something to hide). */
export const KScheduleSchema = z.object({
  events: z.array(CalendarEventSchema),
  reminders: z.array(ReminderSchema),
})
export type KSchedule = z.infer<typeof KScheduleSchema>

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
  /** The run backing this node when known (a lead's latest run / the Chief's live
   *  wake run) — lets the inspector offer a "View run" action. */
  runId?: string
  children: DelegationNode[]
}

// ─── ChiefOrgPayload (GET /api/chief/org — P5.2a) ───────────────────────────
// The ONE batched read that feeds the Chief org-status page. Assembled server-side
// (core/src/routes/chief.ts) so the page issues a single query with no per-item
// fan-out. `health` is deliberately THIN (D-026: no full health strip re-computed
// here) — just the cheap leads-active count.
/** Health counts over a lead's most-recent activations (routes/org-shared.ts::
 *  recentHealth): total scanned, terminal successes, terminal failures. A live
 *  'running' activation counts in `total` only. REAL data derived from agent_runs —
 *  never an invented score/band (D-026 honesty posture). */
export interface RecentRunHealth {
  total: number
  succeeded: number
  failed: number
}

export interface ChiefOrgLead {
  profile: AgentProfile
  /** The lead's most recent agent_run that reached a run (has run_id), else null. */
  latestRun: Run | null
  /** That run's events (bounded) — the source the sub-agent tree is derived from. */
  events: AgentEvent[]
  /** The lead's recent activations (bounded). */
  wakes: AgentRun[]
  /** The lead's newest RESOLVED runs (bounded) — id/status/createdAt/costUsd from the
   *  `runs` table, joined via each activation's run_id (agent_runs itself carries neither
   *  a RunStatus nor cost_usd). Feeds the detail page's Runs tab. Optional (mirrors
   *  effectiveModel/recent) so older payload fixtures stay valid. */
  recentRuns?: Array<{ id: string; status: RunStatus; createdAt: number; costUsd: number }>
  /** The model this lead's next dispatch will actually use: the profile's explicit
   *  override when set, else the runtime Claude default. `source` says which. */
  effectiveModel?: { model: string; source: 'override' | 'runtime-default' }
  /** Success/failure counts over the lead's recent activations. Optional (mirrors
   *  effectiveModel) so existing fixtures/older payloads keep compiling. */
  recent?: RecentRunHealth
}

export interface ChiefOrgHealth {
  leadsActive: number
}

export interface ChiefOrgPayload {
  chief: AgentProfile | null
  /** The K (secretary) profile — Chief's parent in the whole-org tree (user → K → Chief →
   *  leads). Read-only inspection; K is unpatchable. Optional/null so an older payload or an
   *  unseeded K still builds a tree (the client falls back to a synthetic K node). */
  k?: AgentProfile | null
  leads: ChiefOrgLead[]
  /** The Chief's own recent activations (bounded) — the autonomous-wake history. */
  chiefWakes: AgentRun[]
  /** Recent assignments across runs — the Objectives panel source. */
  assignments: Assignment[]
  health: ChiefOrgHealth
  /** Count of K→Chief delegations (chief activations with trigger='delegation',
   *  excluding 'failed' attempts that never reached the Chief) — the K-tier edge count
   *  the whole-org tree (user → K → Chief → …) renders. Optional so an older payload
   *  without it still builds a tree (fullOrgToDelegationTree defaults to 0). */
  kDelegations?: number
  /** Server-authoritative count of leads with a LIVE latest run (=== health.leadsActive).
   *  The ONE source consumers render (web/src/lib/delegation.ts consumes it — the old
   *  client-side re-derivation was deleted in C2). Optional (mirrors kDelegations) so
   *  older payload fixtures stay valid. */
  leadsActive?: number
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
  /** Success/failure counts over the lead's recent activations. Optional (mirrors
   *  ChiefOrgLead.recent) so existing fixtures/older payloads keep compiling. */
  recent?: RecentRunHealth
  /** INT.2 FE IN-3 — last-14d daily activation counts, oldest→newest (index 0 =
   *  13 days ago, index 13 = today). Derived from the SAME bounded per-lead scan
   *  rosterVitals already pays for (org-shared.ts::dailyActivitySeries) — no extra
   *  query. Optional so older payloads/fixtures keep compiling. */
  activitySeries?: number[]
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
  // Whether the skill is armed at creation. Optional — omitted defaults to enabled (1),
  // preserving prior behavior. A schedule/event skill created `enabled:false` must NOT fire
  // until explicitly enabled (registerSkill honors this rather than hardcoding armed).
  enabled: z.boolean().optional(),
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

// ─── Capability catalog (host integration — D-069/D-070/D-071) ───────────────
// The WIRE family for the unified capability catalog (GET /api/capabilities/*):
// K-native assets + skills/MCP/hooks DISCOVERED from the Claude Code host layer
// (~/.claude, project .claude/, plugin cache), each with provenance. STORAGE is
// the extended `skills` table + `host_mcp_servers` (SCHEMA_VERSION 7); these
// schemas are deliberately SEPARATE from SkillSchema above — the automation
// registry's wire shape stays byte-compatible (do NOT fold catalog fields into
// SkillSchema/CreateSkillSchema/UpdateSkillSchema).

/** Where a catalog entry comes from (D-069 provenance). 'k' = K's own
 *  agent-config/ assets; the claude-* kinds are host-discovered. */
export const SkillSourceKindSchema = z.enum(['k', 'claude-user', 'claude-project', 'claude-plugin'])
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>

/** Whether a skill works regardless of model: 'universal' (plain instructions —
 *  usable by Claude AND the Ollama tool loop), 'claude-only' (relies on
 *  claude-specific machinery, e.g. hooks/slash plumbing), 'mcp-dependent'
 *  (needs an MCP server mounted to be useful). Derived at scan time. */
export const ModelCompatSchema = z.enum(['universal', 'claude-only', 'mcp-dependent'])
export type ModelCompat = z.infer<typeof ModelCompatSchema>

/** Catalog-entry liveness: 'ok' = present on disk at the last scan; 'missing' =
 *  vanished from the host (fail-closed at PATCH and at synth — D-069). */
export const CatalogStatusSchema = z.enum(['ok', 'missing'])
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>

/** A structured, non-fatal discovery warning (unreadable host dir, malformed
 *  SKILL.md, unparseable config) — surfaced in the catalog UI banner, never a throw. */
export const CatalogWarningSchema = z.object({
  path: z.string(),
  message: z.string(),
})
export type CatalogWarning = z.infer<typeof CatalogWarningSchema>

export const CatalogSkillSchema = z.object({
  /** == the canonical qualified key (D-069 grammar: `<name>` | `user:<name>` |
   *  `project:<projectId>:<name>` | `plugin:<plugin>@<marketplace>:<name>`). */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sourceKind: SkillSourceKindSchema,
  /** The owning plugin's name for 'claude-plugin' rows; null otherwise. */
  pluginName: z.string().nullable(),
  /** Origin path on disk (provenance display; content is vendor-copied at synth). */
  path: z.string(),
  /** The K-scoped enable overlay (D-069) — K never mutates host ~/.claude files. */
  enabled: z.boolean(),
  /** Estimated FULL-BODY tokens (cost when invoked); null = not yet estimated. */
  estTokens: z.number().int().nullable(),
  /** Estimated name+description tokens (the always-loaded cost); null = not estimated. */
  estTokensMeta: z.number().int().nullable(),
  modelCompat: ModelCompatSchema,
  /** Profiles currently mounting this skill (profile ids). */
  mountedBy: z.array(z.string()),
  status: CatalogStatusSchema,
  /** last_scanned_at unix ms; null = never scanned (a k-native pre-v7 row). */
  updatedAt: z.number().nullable(),
})
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>

export const CatalogSkillsResponseSchema = z.object({
  skills: z.array(CatalogSkillSchema),
  /** unix ms of the last completed discovery scan; null = never scanned. */
  scannedAt: z.number().nullable(),
  warnings: z.array(CatalogWarningSchema),
})
export type CatalogSkillsResponse = z.infer<typeof CatalogSkillsResponseSchema>

export const CatalogMcpServerSchema = z.object({
  /** == qualified key; tier-template ('k') servers use their server name. */
  id: z.string(),
  name: z.string(),
  sourceKind: SkillSourceKindSchema,
  pluginName: z.string().nullable(),
  transport: z.enum(['stdio', 'http', 'sse']),
  /** command + arg summary for the trust dialog. Env NAMES may be shown by the
   *  trust surface; env VALUES never leave core (D-070). */
  commandSummary: z.string(),
  /** Trust is SEPARATE from enable (D-070): trust pins trusted_hash=config_hash;
   *  enabling requires trust; config drift auto-disables + clears trust. */
  trusted: z.boolean(),
  enabled: z.boolean(),
  /** Estimated tool-definition tokens; null until probed. */
  estTokens: z.number().int().nullable(),
  /** Tool count from the probe; null until probed. */
  toolCount: z.number().int().nullable(),
  mountedBy: z.array(z.string()),
  status: CatalogStatusSchema,
})
export type CatalogMcpServer = z.infer<typeof CatalogMcpServerSchema>

export const CatalogMcpResponseSchema = z.object({
  servers: z.array(CatalogMcpServerSchema),
  scannedAt: z.number().nullable(),
  warnings: z.array(CatalogWarningSchema),
})
export type CatalogMcpResponse = z.infer<typeof CatalogMcpResponseSchema>

/** Read-only hook VISIBILITY (host + K provenance). K runs execute only K's
 *  vendored hooks — discovered hooks are listed, never executed (scope decision). */
export const CatalogHookSchema = z.object({
  id: z.string(),
  sourceKind: SkillSourceKindSchema,
  pluginName: z.string().nullable(),
  /** Hook event name (e.g. 'PostToolUse'). */
  event: z.string(),
  matcher: z.string().nullable(),
  commandSummary: z.string(),
})
export type CatalogHook = z.infer<typeof CatalogHookSchema>

export const CatalogHooksResponseSchema = z.object({
  hooks: z.array(CatalogHookSchema),
  scannedAt: z.number().nullable(),
  warnings: z.array(CatalogWarningSchema),
})
export type CatalogHooksResponse = z.infer<typeof CatalogHooksResponseSchema>

/** Result of POST /api/capabilities/rescan — counts of the sync's effects per
 *  asset family. `missing` counts entries newly flagged status='missing'. */
export const RescanResultSchema = z.object({
  scannedAt: z.number(),
  skills: z.object({
    discovered: z.number().int(),
    updated: z.number().int(),
    missing: z.number().int(),
  }),
  mcpServers: z.object({
    discovered: z.number().int(),
    updated: z.number().int(),
    missing: z.number().int(),
  }),
  warnings: z.array(CatalogWarningSchema),
})
export type RescanResult = z.infer<typeof RescanResultSchema>

/** One side (skills / mcp) of the capability summary. `estTokens` sums ONLY the
 *  enabled entries that HAVE an estimate; `unestimatedCount` counts the enabled
 *  entries with no estimate (excluded from the sum + footnoted in the UI —
 *  estimates, never billed tokens). */
const CapabilityTokenSideSchema = z.object({
  enabledCount: z.number().int(),
  estTokens: z.number().int(),
  unestimatedCount: z.number().int(),
})

/** Per-source-kind entry counts (whole catalog, not just enabled). */
const SourceCountsSchema = z.object({
  skills: z.number().int(),
  mcpServers: z.number().int(),
})

/** GET /api/capabilities/summary — enabled-set token totals + per-source counts
 *  (the CapabilityStatRow header source). */
export const CapabilitySummarySchema = z.object({
  skills: CapabilityTokenSideSchema,
  mcp: CapabilityTokenSideSchema,
  /** skills.estTokens + mcp.estTokens — the "total context overhead" figure. */
  totalEstTokens: z.number().int(),
  perSource: z.object({
    'k': SourceCountsSchema,
    'claude-user': SourceCountsSchema,
    'claude-project': SourceCountsSchema,
    'claude-plugin': SourceCountsSchema,
  }),
  scannedAt: z.number().nullable(),
})
export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>

// ─── Skill Creator drafts (D-071) ────────────────────────────────────────────
// An agent-generated skill DRAFT (build → refine → evaluate → save). A draft is
// honest about its state: it is NOT a saved skill until /save writes it into
// K's library (agent-config/skills/) and registers the catalog row.

export const SkillDraftStatusSchema = z.enum(['drafting', 'ready', 'failed'])
export type SkillDraftStatus = z.infer<typeof SkillDraftStatusSchema>

export const SkillDraftSchema = z.object({
  id: z.string(),
  /** Operator's suggested name; null = let the authoring run pick one. */
  nameHint: z.string().nullable(),
  /** The operator's brief the authoring run works from. */
  brief: z.string(),
  /** The drafted SKILL.md content; null until the first authoring run lands. */
  skillMd: z.string().nullable(),
  /** Refinement revision counter (0 = the initial draft). */
  revision: z.number().int(),
  status: SkillDraftStatusSchema,
  /** The live/most-recent authoring run; null when none. */
  runId: z.string().nullable(),
  /** The registered skill id once saved to K's library; null until saved. */
  savedSkillId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type SkillDraft = z.infer<typeof SkillDraftSchema>

/** A draft evaluation — the existing eval-harness semantics keyed to a DRAFT
 *  instead of a registered skill (same lifecycle fields as SkillEval). */
export const DraftEvalSchema = SkillEvalSchema.omit({ skillId: true }).extend({
  draftId: z.string(),
})
export type DraftEval = z.infer<typeof DraftEvalSchema>

// ─── Routing stats ───────────────────────────────────────────────────────────
// Per-(provider,model) outcome aggregates powering the routing dashboard.

export const RoutingModelStatSchema = z.object({
  provider: z.string(),
  model: z.string(),
  runs: z.number().int(),
  terminalRuns: z.number().int(), // terminal-status runs EXCLUDING operator-killed (successRate's denominator)
  successRate: z.number(),   // done / terminal-count, 0..1; operator-killed runs count as neither success nor failure (0 if no terminal runs)
  // Complement of successRate over the SAME killed-excluded terminal population (W9a):
  // (terminal − done) / terminal — i.e. the fraction of finished, non-killed runs that
  // did NOT complete (status error / interrupted). 0 when no terminal runs (W9b F-085).
  errorRate: z.number(),
  avgCostUsd: z.number(),    // mean over runs with cost_usd > 0 (0 if none)
  totalCostUsd: z.number(),
  avgLatencyMs: z.number(),  // mean ACTIVE latency: wall-clock minus awaiting_input parked time, over completed runs (0 if none)
  latencyCount: z.number().int(), // count of runs with a usable latency (avgLatencyMs's denominator)
})
export type RoutingModelStat = z.infer<typeof RoutingModelStatSchema>

export const RoutingStatsSchema = z.object({
  generatedAt: z.number(),
  totalRuns: z.number().int(),
  groups: z.array(RoutingModelStatSchema), // sorted by runs desc, then provider+model asc
  recommendation: z.string(),
  // Org-wide ACTIVE-latency percentiles (parked-excluded, W9a) over ALL runs' latency
  // samples in the window — NOT weightable from per-group means, so computed from the
  // full sample set (linear-interpolation / R-7 method). 0 when no samples (W9b F-086).
  latencyP50Ms: z.number(),
  latencyP95Ms: z.number(),
  latencySamples: z.number().int(), // count of runs contributing a latency sample (percentile denominator)
})
export type RoutingStats = z.infer<typeof RoutingStatsSchema>

// ─── Metrics quality time series (success-rate + latency trend — W9b F-087) ──
// Per-day success-rate and active-latency trend, the time-series companion to the
// single-KPI Success/Avg-latency tiles. successRate/avgLatencyMs are NULL for a day
// with no terminal runs / no latency samples (a genuine GAP, never NaN or a fake 0).
// Uses the SAME killed-excluded terminal + parked-excluded latency definitions as
// aggregateRouting (W9a), so the trend and the KPIs can't contradict each other.
export const MetricsQualityPointSchema = z.object({
  date: z.string(),                       // YYYY-MM-DD local
  terminalRuns: z.number().int(),         // killed-excluded terminal runs that day
  successRate: z.number().nullable(),     // done/terminal, 0..1; null when terminalRuns === 0
  avgLatencyMs: z.number().nullable(),    // mean active latency; null when no latency samples
  latencyCount: z.number().int(),         // latency samples that day (avgLatencyMs denominator)
})
export type MetricsQualityPoint = z.infer<typeof MetricsQualityPointSchema>

export const MetricsQualityTimeseriesSchema = z.object({
  days: z.number().int(),
  dates: z.array(z.string()),                    // YYYY-MM-DD local, oldest → newest
  points: z.array(MetricsQualityPointSchema),    // length === dates.length
})
export type MetricsQualityTimeseries = z.infer<typeof MetricsQualityTimeseriesSchema>

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
    // Credential posture (F-064/F-090), never the credential itself:
    //   'managed'       → a managed token (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) is set;
    //   'host-fallback' → no managed token → runs COPY host ~/.claude credentials (default);
    //   'disabled'      → no managed token + fallback opted out → runs are unauthenticated.
    credentialPosture: z.enum(['managed', 'host-fallback', 'disabled']),
  }),
  voice: z.object({
    enabled: z.boolean(),
    reachable: z.boolean(),
    baseUrl: z.string(),
    model: z.string(),
  }),
})
export type Status = z.infer<typeof StatusSchema>

// ─── System doctor: host prerequisite readiness (Wave 2) ─────────────────────
// GET /api/system/doctor — detects the host tools the desktop app relies on. The
// `claude` CLI is the agent engine K drives and is NOT bundled; git/node are hard
// prerequisites; gh/ollama are optional (K degrades gracefully without them). No
// secrets: a report carries only presence + a one-line version string per tool.

export const DoctorToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  present: z.boolean(),
  version: z.string().nullable(), // the probed `--version` line, or null when absent
  purpose: z.string(),            // why the desktop app needs it (operator guidance)
  installUrl: z.string(),         // where to get it
})
export type DoctorTool = z.infer<typeof DoctorToolSchema>

export const DoctorReportSchema = z.object({
  tools: z.array(DoctorToolSchema),
  ok: z.boolean(), // true iff every REQUIRED tool is present (optional-absent never fails it)
})
export type DoctorReport = z.infer<typeof DoctorReportSchema>

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
// The route for a message to K. `routeForMessage` is the ONE shared, deterministic
// classifier used on BOTH sides of the wire: the composer calls it to preview the
// likely hand-up before send, and the server (core/src/k-thread.ts::askK) calls the
// SAME function and delegates purely on `route.escalates` — so the preview and the
// actual routing decision agree because they are the same computation.

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

/** Clear personal-logistics intents — evaluated BEFORE the lead rules so a message
 *  like "remind me to fix the fence" stays with K even though it embeds an
 *  engineering keyword ("fix"). Deliberate precedence trade-off: these are bare
 *  keyword markers (like the lead rules), so an engineering ask that merely
 *  MENTIONS one — "add a note field to the api response", "the schedule page is
 *  broken" — also stays with K rather than auto-escalating. That direction is
 *  chosen on cost: K under-escalating is a cheap re-ask, while a false escalation
 *  spins up the paid Chief delegation machinery for a grocery note. Kept as a
 *  testable array, mirroring K_ROUTE_RULES. */
const K_LOGISTICS_RULES: ReadonlyArray<RegExp> = [
  /\bremind(er)?s?\b/, // "remind me to…", "set a reminder"
  /\bnote\b/, // "note about…", "take a note"
  /\b(schedule|calendar|meeting|appointment)s?\b/,
  /\badd .+ to my (list|notes?|work items?)\b/,
  /\bwhat'?s on my (list|calendar|schedule)\b/,
]

/** Ordered lead rules — first match wins. Kept as a testable array (not a switch).
 *  Keyword collisions across leads are EXPECTED heuristic behavior, not bugs: e.g.
 *  "fix the flaky auth test" matches 'auth'→security here even though a human might
 *  read it as a Backend test task (F-010). The classifier is a deterministic first-
 *  match keyword preview, not an intent model; when it guesses wrong the operator
 *  forces the lead via forceRoute (KForceRouteSchema / routeForTarget). Refining the
 *  ordering to disambiguate one collision would just shift the ambiguity elsewhere,
 *  so the bias is left explicit and force-route is the escape hatch. */
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
 * Deterministic route for a message to K. Lowercases the message, then:
 *   1. LOGISTICS PRECEDENCE — a clear personal-logistics intent (K_LOGISTICS_RULES:
 *      reminders, notes, scheduling, list management) routes 'logistics' regardless
 *      of embedded engineering keywords ("remind me to fix the fence" stays with K);
 *   2. the lead rules in fixed priority order (frontend → backend → systems →
 *      security → network), then the generic-engineering fallback → Chief;
 *   3. anything else K handles directly (logistics).
 *
 * This classifier is used on BOTH sides: the composer renders it as the route
 * preview, AND the server (k-thread.ts::askK) delegates on its `escalates` flag —
 * it IS the delegation decision, not merely a preview. Client and server agree
 * because both call this same function.
 */
export function routeForMessage(message: string): KRoute {
  const m = message.toLowerCase()
  for (const re of K_LOGISTICS_RULES) {
    if (re.test(m)) {
      return { target: 'logistics', label: K_ROUTE_LABELS.logistics, escalates: false }
    }
  }
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

/** The routes an operator may FORCE for an ask (C2 power controls): every escalating
 *  target — the Chief or a named lead. 'logistics' is deliberately absent: forcing K
 *  to keep an engineering ask would only defeat the delegation machinery. */
export const KForceRouteSchema = z.enum([
  'chief',
  'frontend',
  'backend',
  'systems',
  'security',
  'network',
])
export type KForceRoute = z.infer<typeof KForceRouteSchema>

/**
 * The KRoute for a FORCED target — the same discipline as routeForMessage: this ONE
 * shared mapping is used on BOTH sides of the wire (the composer renders it as the
 * forced-route preview, the server's askK routes on it), so the preview and the
 * actual forced routing agree because they are the same computation. Every forced
 * target escalates by construction (see KForceRouteSchema).
 */
export function routeForTarget(target: KForceRoute): KRoute {
  return { target, label: K_ROUTE_LABELS[target], escalates: true }
}

/** Body for POST /api/k/ask — the operator's message to K, plus the optional power
 *  controls: `forceRoute` bypasses the classifier (routeForTarget wins over
 *  routeForMessage) and `model` is an explicit per-ask model override (validated
 *  against the known-model registry at the route boundary). */
export const KAskBodySchema = z.object({
  message: z.string().min(1).max(20000),
  forceRoute: KForceRouteSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  threadId: z.string().optional(),
})
export type KAskBody = z.infer<typeof KAskBodySchema>

/** Body for POST /api/k/undo — undo a just-started K ask (F-060). Kills the run AND
 *  removes the dangling turns it appended, so an undone message is never replayed into
 *  a later seed/resume. `runId` is the run KAskResult returned. */
export const KUndoBodySchema = z.object({
  runId: z.string().min(1).max(200),
})
export type KUndoBody = z.infer<typeof KUndoBodySchema>

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
 *  is a display hint; `activeRunId` is the warm interactive run (null when cold);
 *  `archivedAt` hides a thread from the default list without deleting it (null =
 *  active/unarchived). */
export const KThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.enum(['active', 'idle']),
  activeRunId: z.string().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type KThread = z.infer<typeof KThreadSchema>

/** A thread plus its list-view preview fields (latest turn text/time) — the shape
 *  GET /api/k/threads returns per row, so the thread list never needs a turns
 *  fetch per row just to render a snippet. */
export const KThreadSummarySchema = KThreadSchema.extend({
  snippet: z.string().nullable(),
  lastTurnAt: z.number().nullable(),
})
export type KThreadSummary = z.infer<typeof KThreadSummarySchema>

/** Body for POST /api/k/threads — creating a thread takes no fields (title is
 *  backfilled from the first turn; see the v11 migration's one-shot backfill). */
export const KThreadCreateBodySchema = z.object({}).strict()

/** Body for PATCH /api/k/threads/:id — rename and/or archive/unarchive. At least
 *  one field must be present. */
export const KThreadPatchBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
}).strict().refine(b => b.title !== undefined || b.archived !== undefined, { message: 'empty patch' })

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

// ─── Home layout (UI Simplification, spec §5.2/§8.3) ───────────────────────
// The operator-arranged widget grid on the Home surface: a fixed 3x3 cell grid,
// each widget spanning 1 or 2 cells per axis, in-bounds and non-overlapping.
export const HomeWidgetIdSchema = z.enum([
  'active_runs', 'needs_you', 'org_glance', 'recent_activity', 'cost_today',
  'personal_tasks', 'notes', 'schedule', 'project_health',
])
export type HomeWidgetId = z.infer<typeof HomeWidgetIdSchema>

export const HomeWidgetPlacementSchema = z.object({
  id: HomeWidgetIdSchema,
  x: z.number().int().min(0).max(2),
  y: z.number().int().min(0).max(2),
  w: z.union([z.literal(1), z.literal(2)]),
  h: z.union([z.literal(1), z.literal(2)]),
}).strict()
export type HomeWidgetPlacement = z.infer<typeof HomeWidgetPlacementSchema>

export const HomeLayoutSchema = z.object({
  widgets: z.array(HomeWidgetPlacementSchema).max(9),
}).strict().superRefine((layout, ctx) => {
  const ids = new Set<string>()
  const cells = new Set<string>()
  for (const wgt of layout.widgets) {
    if (ids.has(wgt.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate widget: ${wgt.id}` })
    ids.add(wgt.id)
    if (wgt.x + wgt.w > 3 || wgt.y + wgt.h > 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `out of bounds: ${wgt.id}` })
      continue
    }
    for (let dx = 0; dx < wgt.w; dx++) for (let dy = 0; dy < wgt.h; dy++) {
      const cell = `${wgt.x + dx},${wgt.y + dy}`
      if (cells.has(cell)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlap at cell ${cell}` })
      cells.add(cell)
    }
  }
})
export type HomeLayout = z.infer<typeof HomeLayoutSchema>

// ─── E-11 canonicalizers (P0) ─────────────────────────────────────────────────
// Legacy status → canonical triple: ONE mapping per entity family, shared by the
// core emit boundary (events.ts) and the web presentation module (lib/status.ts)
// so the two can never drift. Exhaustive switches with NO default: adding a new
// legacy status is a compile error here until it is mapped.

export function canonicalizeRunStatus(s: RunStatus): CanonicalStatus {
  switch (s) {
    case 'queued':         return { state: 'queued',  attention: 'none',         health: 'ok' }
    case 'running':        return { state: 'running', attention: 'none',         health: 'ok' }
    case 'awaiting_input': return { state: 'waiting', attention: 'input_needed', health: 'ok' }
    // awaiting_plan = parked on OPERATOR REVIEW of the plan (process-dead park).
    case 'awaiting_plan': return { state: 'waiting', attention: 'review_needed', health: 'ok' }
    case 'done':           return { state: 'done',    attention: 'none',         health: 'ok' }
    case 'error':          return { state: 'failed',  attention: 'none',         health: 'broken' }
    // killed = the OPERATOR chose to stop it — deliberate, not unhealthy.
    case 'killed':         return { state: 'stopped', attention: 'none',         health: 'ok' }
    // interrupted = a core restart tore it down mid-flight — stopped AND degraded.
    case 'interrupted':    return { state: 'stopped', attention: 'none',         health: 'degraded' }
  }
}

export function canonicalizeAgentRunStatus(s: AgentRunStatus): CanonicalStatus {
  switch (s) {
    case 'running':   return { state: 'running', attention: 'none', health: 'ok' }
    case 'completed': return { state: 'done',    attention: 'none', health: 'ok' }
    case 'failed':    return { state: 'failed',  attention: 'none', health: 'broken' }
  }
}

/** workflow_runs rows share the running/completed/failed shape — same mapping. */
export function canonicalizeWorkflowRunStatus(s: 'running' | 'completed' | 'failed'): CanonicalStatus {
  return canonicalizeAgentRunStatus(s)
}

export function canonicalizeDelegationNodeStatus(s: DelegationNodeStatus): CanonicalStatus {
  switch (s) {
    case 'running': return { state: 'running', attention: 'none', health: 'ok' }
    case 'done':    return { state: 'done',    attention: 'none', health: 'ok' }
    case 'error':   return { state: 'failed',  attention: 'none', health: 'broken' }
    case 'queued':  return { state: 'queued',  attention: 'none', health: 'ok' }
    case 'idle':    return { state: 'idle',    attention: 'none', health: 'ok' }
  }
}

// D-119 pipeline canonicalizers — the DAG colors stages/runs off the shared triple.
/** pipeline_runs status → canonical triple. `cancelled` = an operator-chosen stop
 *  (benign, like a killed run), NOT a failure. */
export function canonicalizePipelineRunStatus(s: PipelineRunStatus): CanonicalStatus {
  switch (s) {
    case 'running':   return { state: 'running', attention: 'none', health: 'ok' }
    case 'completed': return { state: 'done',    attention: 'none', health: 'ok' }
    case 'failed':    return { state: 'failed',  attention: 'none', health: 'broken' }
    case 'cancelled': return { state: 'stopped', attention: 'none', health: 'ok' }
  }
}

/** pipeline_stages status → canonical triple. `dispatched` (claimed; the run is being
 *  created) reads as running; `awaiting_gate` parks on operator review (mirrors a run's
 *  awaiting_plan); `skipped` (an untaken when-branch) is a benign terminal stop. */
export function canonicalizePipelineStageStatus(s: PipelineStageStatus): CanonicalStatus {
  switch (s) {
    case 'pending':       return { state: 'queued',  attention: 'none',          health: 'ok' }
    case 'dispatched':    return { state: 'running', attention: 'none',          health: 'ok' }
    case 'running':       return { state: 'running', attention: 'none',          health: 'ok' }
    case 'awaiting_gate': return { state: 'waiting', attention: 'review_needed', health: 'ok' }
    case 'passed':        return { state: 'done',    attention: 'none',          health: 'ok' }
    case 'failed':        return { state: 'failed',  attention: 'none',          health: 'broken' }
    case 'skipped':       return { state: 'stopped', attention: 'none',          health: 'ok' }
  }
}
