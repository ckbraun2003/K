// Web-local types + pure presentation helpers for the Evals dashboard (F3.W3).
//
// These mirror ONLY the fields the dashboard reads from core's already-built eval HTTP API
// (core/src/routes/evals.ts). They deliberately live here — not in @k/shared — following the
// same precedent as ./skill-runs.ts (a web-local response type the page consumes). Every helper
// is pure and React-free so it unit-tests like ./verify.ts and ./chart.ts.

// ── Response shapes (mirror the backend contract) ──────────────────────────────────────────────

/** GET /api/evals/systems → one seeded system. */
export interface EvalSystemRow {
  id: string
  title: string
  job: string
  enabled: boolean
  caseCount: number
}

/** GET /api/evals/runs → one run summary (most-recent first). */
export interface EvalRunSummary {
  id: string
  status: string
  dry: boolean
  models: string[]
  variants: string[]
  systems: string[]
  totalJobs: number
  completedJobs: number
  totalCostUsd: number
  error: string | null
  createdAt: number
  completedAt: number | null
}

/** Per-system regression verdict vs the frozen DB baselines. `dry` = a dry run's neutral,
 *  un-compared status (fabricated results are never diffed vs real baselines). */
export interface BaselineCompare {
  status: 'no-baseline' | 'REGRESSION' | 'ok' | 'dry'
  deltas?: Record<string, number>
  regressionThreshold?: number
}

export interface VariantStats {
  judgeMean: number | null
  detPassRate: number | null
  detScoreMean: number | null
}

export interface SystemMetrics {
  n: { real: number; degraded: number }
  real: {
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
  degraded: {
    judgeMean: number | null
    detPassRate: number | null
    detScoreMean: number | null
  }
  discriminationJudge: number | null
  discriminationDet: number | null
  discriminationPass: boolean | null
  perModel: Record<
    string,
    {
      real: VariantStats
      degraded: VariantStats
      discriminationJudge: number | null
    }
  >
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

/** GET /api/evals/runs/:id → a run summary with its parsed report (null until complete). */
export type EvalRunDetail = EvalRunSummary & { report: EvalReport | null }

/** GET /api/evals/runs/:id/results → one raw result row. */
export interface EvalResultRow {
  id: string
  evalRunId: string
  systemId: string
  caseId: string
  model: string
  variant: 'real' | 'degraded'
  detPass: number | null
  detScore: number | null
  formatScore: number | null
  judgeOverall: number | null
  judgeVerdict: string | null
  refusalCorrect: number | null
  costUsd: number | null
  ms: number | null
  numTurns: number | null
  error: string | null
  raw: string | null
  createdAt: number
}

// ── Pure helpers (unit-test targets) ───────────────────────────────────────────────────────────

/** Em-dash placeholder for an absent/non-finite numeric. */
export const EMPTY = '—'

/** Fraction → integer percent string, e.g. 0.934 → "93%". null/undefined/non-finite → "—". */
export function formatPct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return EMPTY
  return `${Math.round(x * 100)}%`
}

/** Number → fixed-digit string, e.g. 0.875 → "0.88". null/undefined/non-finite → "—". */
export function formatScore(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return EMPTY
  return x.toFixed(digits)
}

/** USD amount → "$1.23" (4 decimals under $1). null/non-finite → "—". */
export function formatCost(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return EMPTY
  return x < 1 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`
}

/** Job-completion progress for a run. pct is clamped to 0..1 (0 when total is 0). */
export function runProgress(
  run: Pick<EvalRunSummary, 'completedJobs' | 'totalJobs'>,
): { done: number; total: number; pct: number; label: string } {
  const total = Number.isFinite(run.totalJobs) ? Math.max(0, run.totalJobs) : 0
  const done = Number.isFinite(run.completedJobs) ? Math.max(0, run.completedJobs) : 0
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
  return { done, total, pct, label: `${done}/${total}` }
}

/** Discrimination verdict → label + token color class. */
export function discriminationStatus(
  pass: boolean | null,
): { label: string; colorClass: string } {
  if (pass === true) return { label: 'pass', colorClass: 'text-[var(--green)]' }
  if (pass === false) return { label: 'FAIL', colorClass: 'text-[var(--red)]' }
  return { label: 'n/a', colorClass: 'text-[var(--muted)]' }
}

/** Regression verdict → badge label + background-badge classes (AutomationsTab EVAL_BADGE style). */
export function regressionBadge(
  c: BaselineCompare | undefined,
): { label: string; colorClass: string } {
  if (c?.status === 'ok') return { label: 'ok', colorClass: 'bg-green-500/20 text-green-300' }
  if (c?.status === 'REGRESSION')
    return { label: 'REGRESSION', colorClass: 'bg-red-500/20 text-red-300' }
  // A dry run never compares fabricated results to real baselines — show a neutral, non-red badge.
  if (c?.status === 'dry') return { label: 'dry', colorClass: 'bg-[var(--raised)] text-[var(--muted)]' }
  return { label: 'no baseline', colorClass: 'bg-[var(--raised)] text-[var(--muted)]' }
}

/** Run status → badge classes. Mirrors AutomationsTab's RUN_STATUS_COLOR map (default muted). */
const RUN_STATUS_COLOR: Record<string, string> = {
  queued: 'bg-amber/15 text-[var(--amber)]',
  running: 'bg-accent/15 text-[var(--accent-hover)]',
  done: 'bg-green/15 text-[var(--green)]',
  error: 'bg-red/15 text-[var(--red)]',
  killed: 'bg-muted/15 text-[var(--muted)]',
  interrupted: 'bg-red/15 text-[var(--red)]',
}

export function runStatusColor(status: string): string {
  return RUN_STATUS_COLOR[status] ?? 'bg-muted/15 text-[var(--muted)]'
}

/** A null/0/1 deterministic-pass flag → a check / cross / em-dash glyph. */
export function detPassGlyph(detPass: number | null): string {
  if (detPass == null) return EMPTY
  return detPass ? '✓' : '✗'
}

export interface ResultTally {
  passed: number
  failed: number
  total: number
  label: string
}

/**
 * Tally deterministic pass/fail across result rows. A row is FAILED when it errored or its det grade
 * did not pass; PASSED only when detPass === 1; a null detPass with no error is neither. `total` is the
 * completed-row count. This distinguishes PASSED from merely COMPLETED — the run-row progress "N/N"
 * counts completion, which reads (falsely) as all-green even when some rows failed (F-044).
 */
export function resultTally(rows: Pick<EvalResultRow, 'detPass' | 'error'>[]): ResultTally {
  let passed = 0
  let failed = 0
  for (const r of rows) {
    if (r.error != null) failed++
    else if (r.detPass === 1) passed++
    else if (r.detPass === 0) failed++
  }
  return { passed, failed, total: rows.length, label: `${passed}/${rows.length} passed` }
}
