import { z } from 'zod'

// ─── Run ────────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'done',
  'error',
  'killed',
  'interrupted', // terminal: run was running/queued when the core process restarted
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
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
])
export type WsMessage = z.infer<typeof WsMessageSchema>

// ─── API shapes ──────────────────────────────────────────────────────────────

export const StartRunBodySchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().optional(),       // defaults to k/ root
  model: z.string().optional(),     // defaults to router decision
  projectId: z.string().uuid().optional(), // explicit project association (overrides cwd inference)
})
export type StartRunBody = z.infer<typeof StartRunBodySchema>

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
})
export type ProjectTask = z.infer<typeof ProjectTaskSchema>

// ─── PR creation ─────────────────────────────────────────────────────────────

export const CreatePrOptsSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().max(65535).default(''),
  head: z.string().min(1).max(255),
  base: z.string().min(1).max(255),
})
export type CreatePrOpts = z.infer<typeof CreatePrOptsSchema>
