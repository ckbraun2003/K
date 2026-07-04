/**
 * F3.W2a — DB-driven run service (core/src/eval/service.ts).
 *
 * ALL DRY — zero token spend, NO real claude.exe dispatch. Proves: startEvalRun inserts a durable
 * eval_runs row, runs the matrix in the background driven by the DB REGISTRY (loadSystemsFromDb),
 * persists one eval_results row per job, and finalizes the run row ('done' + report JSON, completedJobs,
 * totalCostUsd 0). Plus the 0-job finalize, and DB baseline freeze → compare ('ok' → forced REGRESSION).
 *
 * Operates on the shared module `db` singleton (core tests run serially in one fork over one SQLite
 * file); wipes every eval_* row before AND after so no state leaks across suites — same pattern as
 * eval-store.test.ts. The system + case under test are picked DYNAMICALLY from the DB registry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { db, evalRunsDb, evalResultsDb, evalBaselinesDb } from '../src/db.js'
import { seedEvalSystems, loadSystemsFromDb } from '../src/eval/store.js'
import { startEvalRun, freezeBaselinesFromRun, compareRunToBaselines } from '../src/eval/service.js'
import { repoRoot } from '../src/eval/systems.js'
import type { EvalReport, EvalRecord, SystemMetrics } from '../src/eval/types.js'

const root = repoRoot()
const reportsDir = mkdtempSync(path.join(os.tmpdir(), 'k-eval-svc-reports-'))
const baseDir = mkdtempSync(path.join(os.tmpdir(), 'k-eval-svc-base-'))

interface EvalRunRow {
  status: string
  completedJobs: number
  totalCostUsd: number
  dry: number
  report: string | null
  error: string | null
  completedAt: number | null
}
interface EvalResultRow {
  systemId: string
  caseId: string
  model: string
  variant: string
  detPass: number | null
  detScore: number | null
  judgeOverall: number | null
  costUsd: number | null
  error: string | null
  raw: string
}

function wipe(): void {
  db.exec('DELETE FROM eval_baselines')
  db.exec('DELETE FROM eval_results')
  db.exec('DELETE FROM eval_runs')
  db.exec('DELETE FROM eval_cases')
  db.exec('DELETE FROM eval_systems')
}

let evalRunId: string
let sysId: string
let caseId: string
let expectedJobs: number

beforeAll(async () => {
  wipe()
  seedEvalSystems({ root }) // populate the DB registry — the run must read systems from HERE, not files
  const sys = loadSystemsFromDb({ root })[0]
  sysId = sys.id
  caseId = sys.cases[0].id
  // models=['sonnet'], 1 case → 1 'real' job + 1 'degraded' job iff the system has a degraded prompt.
  expectedJobs = 1 + (sys.degradedFile ? 1 : 0)

  const started = startEvalRun({
    dry: true,
    systems: [sysId],
    cases: [caseId],
    models: ['sonnet'],
    variants: ['real', 'degraded'],
    reportsDir,
    baseDir,
  })
  evalRunId = started.evalRunId
  await started.completed // resolves only once the run row is FINALIZED — deterministic, no polling
})

afterAll(() => {
  wipe()
  for (const d of [reportsDir, baseDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('startEvalRun — DB-driven dry run finalizes', () => {
  it('finalizes the eval_runs row: done, completedJobs == jobs, $0, parseable report', () => {
    const run = evalRunsDb.getEvalRun.get(evalRunId) as EvalRunRow
    expect(run).toBeDefined()
    expect(run.status).toBe('done')
    expect(run.dry).toBe(1)
    expect(run.completedJobs).toBe(expectedJobs)
    expect(run.totalCostUsd).toBe(0)
    expect(run.error).toBeNull()
    expect(run.completedAt).not.toBeNull()

    expect(run.report).not.toBeNull()
    const report = JSON.parse(run.report as string) as EvalReport
    expect(report.dry).toBe(true)
    expect(report.overall.totalCostUsd).toBe(0)
    expect(report.perSystem[sysId]).toBeDefined()
  })

  it('persists one eval_results row per job, sourced from the DB registry, with mapped fields', () => {
    const rows = evalResultsDb.listEvalResultsByRun.all(evalRunId) as EvalResultRow[]
    expect(rows.length).toBe(expectedJobs)

    // every row belongs to the seeded (DB) system/case — proves loadSystemsFromDb drove the matrix
    for (const r of rows) {
      expect(r.systemId).toBe(sysId)
      expect(r.caseId).toBe(caseId)
      expect(r.model).toBe('sonnet')
      expect(['real', 'degraded']).toContain(r.variant)
      expect(r.error).toBeNull()
      expect(r.costUsd).toBe(0)            // dry
      expect(r.judgeOverall).toBeNull()    // judge skipped on the dry path
      expect([0, 1]).toContain(r.detPass)  // deterministic grading still runs
      const rec = JSON.parse(r.raw) as EvalRecord
      expect(rec.system).toBe(sysId)
    }
    // both variants present (the degraded dryResult branch was exercised too)
    if (expectedJobs === 2) {
      expect(rows.map(r => r.variant).sort()).toEqual(['degraded', 'real'])
    }
  })
})

describe('startEvalRun — empty matrix finalizes cleanly (0 jobs)', () => {
  it('a run with no matching systems finalizes done with 0 results (durable, never crashes)', async () => {
    // An unknown system id yields an empty matrix. With the runner's existsSync guard the never-written
    // results.jsonl is no longer read, so aggregation runs over [] → an empty report and a clean 'done'
    // finalize (W2b). The degrade-to-'error' path remains defensively coded but no longer fires here.
    const { evalRunId: zid, completed } = startEvalRun({
      dry: true,
      systems: ['___nonexistent___'],
      models: ['sonnet'],
      variants: ['real'],
      reportsDir,
      baseDir,
    })
    await expect(completed).resolves.toBeUndefined() // never rejects out of the background run
    const run = evalRunsDb.getEvalRun.get(zid) as EvalRunRow
    expect(run.status).toBe('done')
    expect(run.error).toBeNull()
    expect(run.completedJobs).toBe(0)
    expect(run.totalCostUsd).toBe(0)
    expect(run.report).not.toBeNull()
    expect(run.completedAt).not.toBeNull()
    expect(evalResultsDb.listEvalResultsByRun.all(zid).length).toBe(0)
  })
})

describe('freezeBaselinesFromRun + compareRunToBaselines (DB-backed)', () => {
  // Freezing is only legal for a NON-DRY run — a dry run's per-system metrics are fabricated ($0,
  // always-pass) and must never become baselines. `evalRunId` (module beforeAll) is a DRY run, so the
  // freeze/compare-ok flow here drives a synthetic NON-DRY completed run inserted directly via the repos
  // (deterministic, no real spend).
  let nonDryRunId: string
  function makeMetrics(): SystemMetrics {
    return {
      n: { real: 1, degraded: 1 },
      real: {
        judgeMean: 0.9, detPassRate: 1, detScoreMean: 0.95, formatMean: 1, refusalCorrectRate: null,
        costUsd: 0.05, latencyMsMean: 1000, turnsMean: 2, tokensInSum: null, tokensOutSum: null,
      },
      degraded: { judgeMean: 0.3, detPassRate: 0, detScoreMean: 0.2 },
      discriminationJudge: 0.6, discriminationDet: 0.75, discriminationPass: true, perModel: {},
    }
  }
  beforeAll(() => {
    nonDryRunId = uuid()
    const report: EvalReport = {
      runId: nonDryRunId, generatedAt: new Date().toISOString(), models: ['sonnet'],
      variants: ['real', 'degraded'], dry: false,
      overall: {
        systems: 1, models: ['sonnet'], totalRecords: 2, totalCostUsd: 0.05, realJudgeMean: 0.9,
        realDetPassRate: 1, discriminationPassCount: 1, discriminationThreshold: 0.15,
        detDiscriminationThreshold: 0.1,
      },
      perSystem: { [sysId]: makeMetrics() }, regression: {}, baselinesFrozen: [],
    }
    evalRunsDb.insertEvalRun.run({
      id: nonDryRunId, status: 'done', models: JSON.stringify(['sonnet']),
      variants: JSON.stringify(['real', 'degraded']), systems: JSON.stringify([sysId]), dry: 0,
      totalJobs: 2, completedJobs: 2, totalCostUsd: 0.05, report: JSON.stringify(report), error: null,
      createdAt: Date.now(), completedAt: Date.now(),
    })
    db.exec('DELETE FROM eval_baselines') // start from a clean baseline slate
  })

  it('REFUSES to freeze a DRY run (fabricated metrics must never become baselines)', () => {
    expect(() => freezeBaselinesFromRun(evalRunId)).toThrow(/dry/i)
    expect(evalBaselinesDb.getEvalBaseline.get(sysId)).toBeUndefined() // nothing was written
  })

  it('freezes per-system baselines from a NON-DRY run report and returns the system ids', () => {
    const frozen = freezeBaselinesFromRun(nonDryRunId)
    expect(frozen).toContain(sysId)
    const b = evalBaselinesDb.getEvalBaseline.get(sysId) as { metrics: string; evalRunId: string }
    expect(b).toBeDefined()
    expect(b.evalRunId).toBe(nonDryRunId)
    expect(() => JSON.parse(b.metrics)).not.toThrow()
  })

  it('compares ok (zero deltas) against the just-frozen baseline', () => {
    const cmp = compareRunToBaselines(nonDryRunId)
    expect(cmp[sysId]).toBeDefined()
    expect(cmp[sysId].status).toBe('ok')
  })

  it('flags REGRESSION when a stored baseline metric is raised above the run value', () => {
    // Read the frozen baseline, bump real.detScoreMean well above the run's value, write it back, and
    // re-compare → the negative delta (now - was) trips the regression threshold.
    const b = evalBaselinesDb.getEvalBaseline.get(sysId) as { metrics: string }
    const metrics = JSON.parse(b.metrics) as { real: { detScoreMean: number | null } }
    expect(typeof metrics.real.detScoreMean).toBe('number')
    metrics.real.detScoreMean = (metrics.real.detScoreMean as number) + 1
    evalBaselinesDb.upsertEvalBaseline.run({
      systemId: sysId,
      metrics: JSON.stringify(metrics),
      evalRunId: nonDryRunId,
      frozenAt: Date.now(),
    })

    const cmp = compareRunToBaselines(nonDryRunId)
    expect(cmp[sysId].status).toBe('REGRESSION')
    expect(cmp[sysId].deltas?.detScoreMean).toBeLessThan(-0.1)
  })

  it('reports no-baseline for a system with no frozen row', () => {
    db.exec('DELETE FROM eval_baselines')
    const cmp = compareRunToBaselines(nonDryRunId)
    expect(cmp[sysId].status).toBe('no-baseline')
  })
})
