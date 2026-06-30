// F3.W2a — DB-driven run service for the ported T-EVAL harness. Drives the matrix runner from the
// DB registry (loadSystemsFromDb), persists every result into eval_results, finalizes the eval_runs
// row, and does DB-backed baseline freeze + regression compare. NO HTTP routes, NO boot wiring (W2b).
//
// TOKEN SAFETY: `startEvalRun` defaults `dry` to TRUE. A real (spend) run requires an EXPLICIT
// `dry: false`. The dry path fabricates results in the runner and never dispatches claude.exe.
//
// Like store.ts, statements are prepared on the RESOLVED connection (`opts.db ?? moduleDb`) so an
// isolated (injected) DB can be driven as well as the module singleton. SQL mirrors db.ts's eval
// repos exactly (column names/params); kept local here for the injectable-connection seam.
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { db as moduleDb } from '../db.js'
import { loadSystemsFromDb } from './store.js'
import { runEvalMatrix } from './runner.js'
import { compareMetricsToBaseline } from './metrics.js'
import { repoRoot } from './systems.js'
import type { BaselineCompare, BaselineFile, EvalRecord, EvalReport, EvalSystem, SystemMetrics } from './types.js'

/** The eval_results column set produced by recToEvalResultRow (matches db.ts insertEvalResult). */
export interface EvalResultRow {
  id: string
  evalRunId: string
  systemId: string
  caseId: string
  model: string
  variant: string
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
  raw: string
  createdAt: number
}

/** Prepared statements bound to one connection (re-prepared per public call, like store.ts). */
function prepare(d: Database.Database) {
  return {
    insertRun: d.prepare(`
      INSERT INTO eval_runs (id, status, models, variants, systems, dry, totalJobs, completedJobs, totalCostUsd, report, error, createdAt, completedAt)
      VALUES (@id, @status, @models, @variants, @systems, @dry, @totalJobs, @completedJobs, @totalCostUsd, @report, @error, @createdAt, @completedAt)
    `),
    getRun: d.prepare(`SELECT * FROM eval_runs WHERE id = ?`),
    updateTotalJobs: d.prepare(`UPDATE eval_runs SET totalJobs = @totalJobs WHERE id = @id`),
    updateProgress: d.prepare(`
      UPDATE eval_runs SET completedJobs = @completedJobs, totalCostUsd = @totalCostUsd WHERE id = @id
    `),
    updateStatus: d.prepare(`
      UPDATE eval_runs SET status = @status, report = @report, error = @error, completedAt = @completedAt WHERE id = @id
    `),
    insertResult: d.prepare(`
      INSERT INTO eval_results (id, evalRunId, systemId, caseId, model, variant, detPass, detScore, formatScore, judgeOverall, judgeVerdict, refusalCorrect, costUsd, ms, numTurns, error, raw, createdAt)
      VALUES (@id, @evalRunId, @systemId, @caseId, @model, @variant, @detPass, @detScore, @formatScore, @judgeOverall, @judgeVerdict, @refusalCorrect, @costUsd, @ms, @numTurns, @error, @raw, @createdAt)
    `),
    upsertBaseline: d.prepare(`
      INSERT INTO eval_baselines (systemId, metrics, evalRunId, frozenAt)
      VALUES (@systemId, @metrics, @evalRunId, @frozenAt)
      ON CONFLICT(systemId) DO UPDATE SET metrics = excluded.metrics, evalRunId = excluded.evalRunId, frozenAt = excluded.frozenAt
    `),
    getBaseline: d.prepare(`SELECT * FROM eval_baselines WHERE systemId = ?`),
  }
}

const bool01 = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0)

/**
 * Map one runner record → an eval_results row. Error records (rec.error set) store the error string
 * with null metrics; success records map det/judge/metrics. `raw` always carries the full record JSON.
 */
export function recToEvalResultRow(evalRunId: string, rec: EvalRecord): EvalResultRow {
  const err = rec.error ?? null
  return {
    id: randomUUID(),
    evalRunId,
    systemId: rec.system,
    caseId: rec.caseId ?? '',
    model: rec.model,
    variant: rec.variant,
    detPass: err ? null : bool01(rec.det?.detPass),
    detScore: err ? null : (rec.det?.detScore ?? null),
    formatScore: err ? null : (rec.det?.formatScore ?? null),
    judgeOverall: err ? null : (rec.judge?.overall ?? null),
    judgeVerdict: err ? null : (rec.judge?.verdict ?? null),
    refusalCorrect: err ? null : bool01(rec.metricsRaw?.refusalCorrect),
    costUsd: err ? null : (rec.metricsRaw?.costUsd ?? null),
    ms: err ? null : (rec.metricsRaw?.ms ?? null),
    numTurns: err ? null : (rec.metricsRaw?.numTurns ?? null),
    error: err,
    raw: JSON.stringify(rec),
    createdAt: Date.now(),
  }
}

/** The default model/variant matrix applied when a run request omits them. Exported so the HTTP
 *  pre-flight job count (routes/evals.ts) uses the SAME defaults the run actually applies — without
 *  these shared, the two could drift and the pre-flight would mis-count. */
export const DEFAULT_EVAL_MODELS = ['opus', 'sonnet']
export const DEFAULT_EVAL_VARIANTS = ['real', 'degraded']

export interface StartEvalRunOptions {
  systems?: string[]
  cases?: string[]
  models?: string[]
  variants?: string[]
  /** DEFAULTS TO TRUE (token-safety). A real spend run REQUIRES an explicit `dry: false`. */
  dry?: boolean
  runId?: string
  reportsDir?: string
  baseDir?: string
  root?: string
  db?: Database.Database
}

/**
 * Insert a durable eval_runs row (status 'running'), then launch the matrix runner in the BACKGROUND
 * driven by the DB registry (loadSystemsFromDb). Each completed job is persisted to eval_results and
 * bumps the run's completedJobs/totalCostUsd. On completion the row is finalized: 'done' + report JSON
 * (or 'error' + the error string). Mirrors skills.ts::runSkillTest's "durable row, then degrade-on-throw".
 *
 * Returns `{ evalRunId, completed }`. Production callers ignore `completed`; tests await it to observe
 * the FINALIZED row deterministically (no polling/sleeps). `dry` DEFAULTS TO TRUE.
 */
export function startEvalRun(opts: StartEvalRunOptions = {}): { evalRunId: string; completed: Promise<void> } {
  const d = opts.db ?? moduleDb
  const stmts = prepare(d)
  const root = opts.root ?? repoRoot()
  const dry = opts.dry ?? true
  const models = opts.models ?? DEFAULT_EVAL_MODELS
  const variants = opts.variants ?? DEFAULT_EVAL_VARIANTS
  const evalRunId = opts.runId ?? randomUUID()

  // Default report/sandbox dirs to a temp area — NEVER under testing/eval/reports/.
  const dataRoot = process.env.K_DATA_DIR ?? os.tmpdir()
  const reportsDir = opts.reportsDir ?? path.join(dataRoot, 'k-eval-runs', evalRunId, 'reports')
  const baseDir = opts.baseDir ?? path.join(dataRoot, 'k-eval-runs', evalRunId, 'sandbox')

  // Durable run row BEFORE launch (so it survives a crash mid-run). totalJobs is filled by the runner's
  // matrix; we leave it 0 here and track completedJobs as records arrive.
  stmts.insertRun.run({
    id: evalRunId,
    status: 'running',
    models: JSON.stringify(models),
    variants: JSON.stringify(variants),
    systems: JSON.stringify(opts.systems ?? []),
    dry: dry ? 1 : 0,
    totalJobs: 0,
    completedJobs: 0,
    totalCostUsd: 0,
    report: null,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
  })

  let completedJobs = 0
  let totalCostUsd = 0

  const completed = (async (): Promise<void> => {
    try {
      const report: EvalReport = await runEvalMatrix({
        root,
        baseDir,
        reportsDir,
        systems: opts.systems,
        cases: opts.cases,
        models,
        variants,
        dry,
        runId: evalRunId,
        // DB registry instead of the file loader (the W2a injection point).
        loadSystemsFn: (args: { root: string; only?: string[] }): EvalSystem[] =>
          loadSystemsFromDb({ root: args.root, only: args.only, db: d }),
        // Record the resolved matrix size on the durable row once the runner has built the job matrix.
        onStart: ({ totalJobs }): void => { stmts.updateTotalJobs.run({ id: evalRunId, totalJobs }) },
        // Persist each completed job + bump run progress.
        onRecord: (rec: EvalRecord): void => {
          stmts.insertResult.run(recToEvalResultRow(evalRunId, rec))
          completedJobs += 1
          totalCostUsd += rec.metricsRaw?.costUsd ?? 0
          stmts.updateProgress.run({ id: evalRunId, completedJobs, totalCostUsd })
        },
      })
      stmts.updateStatus.run({
        id: evalRunId,
        status: 'done',
        report: JSON.stringify(report),
        error: null,
        completedAt: Date.now(),
      })
    } catch (e) {
      // Graceful degrade (mirrors runSkillTest): finalize as 'error' + store the message; never throw
      // out of the background run. The finalize write is itself guarded so a secondary failure (e.g. a
      // closed DB connection) can't turn the detached `completed` promise into an unhandled rejection.
      console.warn(`[eval] startEvalRun ${evalRunId} failed:`, e)
      try {
        stmts.updateStatus.run({
          id: evalRunId,
          status: 'error',
          report: null,
          error: String((e && (e as Error).stack) || e),
          completedAt: Date.now(),
        })
      } catch (e2) {
        console.error(`[eval] startEvalRun ${evalRunId} could not record error status:`, e2)
      }
    }
  })()

  return { evalRunId, completed }
}

/**
 * Freeze DB baselines from a finished run's stored report: upsert one eval_baselines row per system
 * (metrics = that system's per-system SystemMetrics JSON). Returns the frozen system ids. No-op (returns
 * []) if the run has no stored report yet.
 */
export function freezeBaselinesFromRun(
  evalRunId: string,
  opts: { db?: Database.Database } = {},
): string[] {
  const d = opts.db ?? moduleDb
  const stmts = prepare(d)
  const run = stmts.getRun.get(evalRunId) as { report: string | null } | undefined
  if (!run || !run.report) return []
  const report = JSON.parse(run.report) as EvalReport
  const now = Date.now()
  const frozen: string[] = []
  for (const [sys, metrics] of Object.entries(report.perSystem)) {
    stmts.upsertBaseline.run({
      systemId: sys,
      metrics: JSON.stringify(metrics),
      evalRunId,
      frozenAt: now,
    })
    frozen.push(sys)
  }
  return frozen
}

/**
 * Compare a finished run's per-system metrics to the DB baselines, reusing the SAME threshold rule as
 * metrics.compareToBaselines (via the shared compareMetricsToBaseline helper) — only the baseline source
 * differs (the eval_baselines row's metrics JSON instead of a file). Per system: 'ok' | 'REGRESSION' |
 * 'no-baseline'.
 */
export function compareRunToBaselines(
  evalRunId: string,
  opts: { db?: Database.Database; regressionThreshold?: number } = {},
): Record<string, BaselineCompare> {
  const d = opts.db ?? moduleDb
  const stmts = prepare(d)
  const regressionThreshold = opts.regressionThreshold ?? 0.1
  const out: Record<string, BaselineCompare> = {}
  const run = stmts.getRun.get(evalRunId) as { report: string | null } | undefined
  if (!run || !run.report) return out
  const report = JSON.parse(run.report) as EvalReport
  for (const [sys, m] of Object.entries(report.perSystem)) {
    const baseRow = stmts.getBaseline.get(sys) as { metrics: string } | undefined
    if (!baseRow) { out[sys] = { status: 'no-baseline' }; continue }
    // A DB baseline stores a SystemMetrics object; it exposes the same .real.{key} + .discriminationJudge
    // keys the comparison reads, so a BaselineFile cast is structurally safe here.
    const base = JSON.parse(baseRow.metrics) as BaselineFile
    out[sys] = compareMetricsToBaseline(m as SystemMetrics, base, regressionThreshold)
  }
  return out
}
