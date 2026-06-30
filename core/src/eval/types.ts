// Shared TypeScript types for the T-EVAL harness (ported from testing/eval/harness/*.mjs).
//
// This is a behavior-preserving lift of the proven out-of-band harness into @k/core. The types
// describe exactly the shapes the original modules passed around as plain objects — nothing more.
// JSON is parsed at a few narrow boundaries (stream-json events, cases/registry/baseline files);
// those casts are localized and commented in the modules that own them.

// ── Cases / registry data (pure JSON authored under testing/eval/) ──────────────────────────────

/**
 * A single deterministic check (the CHECKS DSL). Known params per check-type are declared so the
 * graders can read them typed; the index signature keeps the shape permissive for forward-compatible
 * check types. Each check-type only reads the subset of fields it documents.
 */
export interface Check {
  type: string
  label?: string
  weight?: number
  critical?: boolean
  format?: boolean
  // check-specific parameters (each used only by the matching check-type)
  any?: string[]
  all?: string[]
  pattern?: string
  flags?: string
  expect?: boolean
  min?: number
  max?: number
  tool?: string
  is?: string
  path?: string
  pathIncludes?: string
  [k: string]: unknown
}

/** A scenario case (pure JSON data, graded by graders.ts / judge.ts). */
export interface EvalCase {
  id: string
  title?: string
  fixture?: string
  allowedTools?: string[]
  refusalExpected?: boolean
  input: string
  checks?: Check[]
  judge?: boolean
  maxTurns?: number
  timeoutMs?: number
}

/** One entry in testing/eval/systems.json (paths are repo-relative or absolute). */
export interface SystemRegistryEntry {
  id: string
  title: string
  job?: string
  promptFile: string
  degradedFile?: string
  rubric: string
  casesFile: string
  allowedTools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
}

export interface SystemRegistry {
  systems: SystemRegistryEntry[]
  [k: string]: unknown
}

/** A fully-loaded system-under-eval (registry entry + resolved files + cases). */
export interface EvalSystem {
  id: string
  title: string
  job: string
  promptFile: string
  degradedFile: string
  allowedTools: string[]
  disallowedTools: string[]
  maxTurns: number
  rubricText: string
  cases: EvalCase[]
}

// ── Dispatch (real claude -p stream-json → structured result) ───────────────────────────────────

export interface DispatchUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  [k: string]: unknown
}

export interface PermissionDenial {
  tool_name?: string
  [k: string]: unknown
}

export interface ToolUse {
  name: string
  input: unknown
}

/** One content block inside an assistant message event. */
export interface ContentBlock {
  type?: string
  name?: string
  input?: unknown
  text?: string
  [k: string]: unknown
}

/** A parsed stream-json event line (assistant or result). Loosely typed: it comes from JSON.parse. */
export interface StreamEvent {
  type?: string
  message?: { content?: ContentBlock[] }
  result?: string
  is_error?: boolean
  api_error_status?: string | null
  stop_reason?: string
  num_turns?: number
  total_cost_usd?: number
  usage?: DispatchUsage
  modelUsage?: Record<string, unknown>
  permission_denials?: PermissionDenial[]
  [k: string]: unknown
}

/** Raw, pre-parse capture handed to finalize(). */
export interface RawDispatch {
  outcome: string
  code?: number | null
  error?: string | null
  ms: number
  stdout: string
  stderr: string
}

export interface DispatchOptions {
  input: string
  systemPromptFile?: string
  model?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  cwd: string
  dataDir: string
  runId?: string
  maxTurns?: number
  permissionMode?: string
  timeoutMs?: number
}

/** The structured result finalize() produces from a dispatch. */
export interface DispatchResult {
  outcome: string
  code: number | null
  error: string | null
  ms: number
  text: string
  isError: boolean | null
  apiErrorStatus: string | null
  stopReason: string | null
  numTurns: number | null
  costUsd: number | null
  usage: DispatchUsage | null
  modelUsed: string | null | undefined
  denials: PermissionDenial[]
  deniedTools: string[]
  toolUses: ToolUse[]
  toolNames: string[]
  eventCount: number
  stderrTail: string
}

// ── Sandbox (disposable worktree + isolated data dir) ───────────────────────────────────────────

/** Snapshot of the worktree post-dispatch (sandbox.collect()). */
export interface SandboxPost {
  isRepo: boolean
  commitCount: number
  newCommits: number
  log: string[]
  status: string
  branches: string[]
  currentBranch: string
  createdFiles: string[]
  dirty: boolean
  committedToMain: boolean
  fileContents: Record<string, string>
}

export interface Sandbox {
  cwd: string
  dataDir: string
  fixture: string
  collect(): SandboxPost
  cleanup(): void
}

// ── Deterministic grading ───────────────────────────────────────────────────────────────────────

/** The context grade() resolves checks against (result + worktree post-state). */
export interface GradeContext {
  result?: Partial<DispatchResult> | null
  post?: Partial<SandboxPost> | null
}

/** Internal per-grade state derived from the dispatch result. */
export interface GraderState {
  text: string
  toolNames: string[]
  deniedTools: string[]
  usedTools: string[]
  denials: PermissionDenial[]
  numTurns: number | null | undefined
  stopReason: string | null | undefined
  outcome: string | undefined
  isError: boolean | null | undefined
  post: Partial<SandboxPost> | null
}

/** A single check function's raw verdict. */
export interface CheckRaw {
  pass: boolean
  detail: string
}

/** A graded check (raw verdict + the case's weighting/tags). */
export interface CheckResult {
  type: string
  label: string
  weight: number
  critical: boolean
  format: boolean
  pass: boolean
  detail: string
}

export interface GradeResult {
  checks: CheckResult[]
  detScore: number
  detPass: boolean
  formatScore: number | null
  criticalFailures: string[]
}

// ── LLM judge ───────────────────────────────────────────────────────────────────────────────────

/** The strict-JSON object the judge model is asked to emit. */
export interface JudgeJson {
  scores?: Record<string, unknown>
  overall?: number
  verdict?: string
  rationale?: string
}

export interface JudgeResult {
  ok: boolean
  overall: number | null
  verdict: string | null
  scores: Record<string, unknown>
  rationale: string
  costUsd: number
  raw?: string
}

// ── Aggregation / metrics ────────────────────────────────────────────────────────────────────────

export interface EvalDetResult {
  detPass?: boolean
  detScore?: number
  formatScore?: number | null
  criticalFailures?: string[]
}

export interface EvalJudgeResult {
  overall?: number | null
  verdict?: string | null
  rationale?: string
}

export interface EvalMetricsRaw {
  costUsd?: number
  ms?: number | null
  numTurns?: number | null
  refusalCorrect?: boolean | null
  tokensIn?: number | null
  tokensOut?: number | null
  cacheReadTokens?: number | null
}

/** One JSONL record (the runner writes the rich shape; error records carry only `error`). */
export interface EvalRecord {
  jobKey?: string
  system: string
  caseId?: string
  title?: string
  model: string
  variant: string
  det?: EvalDetResult | null
  judge?: EvalJudgeResult | null
  metricsRaw?: EvalMetricsRaw
  dispatch?: {
    outcome?: string
    isError?: boolean | null
    stopReason?: string | null
    usedTools?: string[]
    deniedTools?: string[]
    textHead?: string
  }
  post?: { newCommits?: number; dirty?: boolean; committedToMain?: boolean }
  checks?: Array<{ label: string; pass: boolean; critical: boolean }>
  ts?: string
  error?: string
}

export interface AggregateOptions {
  discriminationThreshold?: number
  detDiscriminationThreshold?: number
}

export interface VariantStats {
  judgeMean: number | null
  detPassRate: number | null
  detScoreMean: number | null
}

export interface PerModelMetrics {
  real: VariantStats
  degraded: VariantStats
  discriminationJudge: number | null
}

export interface SystemRealMetrics {
  judgeMean: number | null
  detPassRate: number | null
  detScoreMean: number | null
  formatMean: number | null
  refusalCorrectRate: number | null
  costUsd: number | null
  latencyMsMean: number | null
  turnsMean: number | null
  tokensInSum: number | null
  tokensOutSum: number | null
}

export interface SystemDegradedMetrics {
  judgeMean: number | null
  detPassRate: number | null
  detScoreMean: number | null
}

export interface SystemMetrics {
  n: { real: number; degraded: number }
  real: SystemRealMetrics
  degraded: SystemDegradedMetrics
  discriminationJudge: number | null
  discriminationDet: number | null
  discriminationPass: boolean | null
  perModel: Record<string, PerModelMetrics>
}

export interface OverallMetrics {
  systems: number
  models: string[]
  totalRecords: number
  totalCostUsd: number | null
  realJudgeMean: number | null
  realDetPassRate: number | null
  discriminationPassCount: number
  discriminationThreshold: number
  detDiscriminationThreshold: number
}

export interface AggregateResult {
  perSystem: Record<string, SystemMetrics>
  overall: OverallMetrics
}

/** The on-disk frozen baseline shape (written by writeBaselines, read by compareToBaselines). */
export interface BaselineFile {
  system?: string
  frozenAt?: string
  real?: Partial<SystemRealMetrics>
  degraded?: Partial<SystemDegradedMetrics>
  discriminationJudge?: number | null
  discriminationDet?: number | null
  discriminationPass?: boolean | null
  perModel?: Record<string, PerModelMetrics>
}

export interface BaselineCompare {
  status: 'no-baseline' | 'REGRESSION' | 'ok'
  deltas?: Record<string, number>
  regressionThreshold?: number
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────────

export interface RunMatrixOptions {
  /** Repo root used to resolve testing/eval/ files + the baselines dir. Default: repoRoot(). */
  root?: string
  /** Disposable sandbox parent dir. Default: <CLAUDE_JOB_DIR|root>/tmp/k-eval. */
  baseDir?: string
  /** Where {runId}.json/.md + _runs/{runId}/results.jsonl are written. Default: <root>/testing/eval/reports. */
  reportsDir?: string
  /** System ids to include (the registry filter). Default: all. */
  systems?: string[]
  models?: string[]
  variants?: string[]
  cases?: string[]
  concurrency?: number
  turnsCap?: number
  dry?: boolean
  runId?: string
  updateBaselines?: boolean
  /**
   * Optional sink invoked once per completed job, right AFTER the JSONL append, with the same
   * `rec` object. Errors thrown by the sink are caught so they can't abort the matrix. Default: none.
   * (F3.W2a: the DB run service uses this to persist each result + bump run progress.)
   */
  onRecord?: (rec: EvalRecord) => void
  /**
   * Optional systems source, defaulting to the internal file loader `loadSystems`. When provided,
   * the runner reads the registry through this instead — how the service injects `loadSystemsFromDb`
   * (the DB registry). Default preserves W1a behavior exactly.
   */
  loadSystemsFn?: (args: { root: string; only?: string[] }) => EvalSystem[]
}

export interface EvalReport {
  runId: string
  generatedAt: string
  models: string[]
  variants: string[]
  dry: boolean
  overall: OverallMetrics
  perSystem: Record<string, SystemMetrics>
  regression: Record<string, BaselineCompare>
  baselinesFrozen: string[]
}

export interface EvalJob {
  sys: EvalSystem
  kase: EvalCase
  model: string
  variant: string
  jobKey: string
}
