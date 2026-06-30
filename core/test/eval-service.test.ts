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
import { db, evalRunsDb, evalResultsDb, evalBaselinesDb } from '../src/db.js'
import { seedEvalSystems, loadSystemsFromDb } from '../src/eval/store.js'
import { startEvalRun, freezeBaselinesFromRun, compareRunToBaselines } from '../src/eval/service.js'
import { repoRoot } from '../src/eval/systems.js'
import type { EvalReport, EvalRecord } from '../src/eval/types.js'

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
  it('freezes per-system baselines from the run report and returns the system ids', () => {
    const frozen = freezeBaselinesFromRun(evalRunId)
    expect(frozen).toContain(sysId)
    const b = evalBaselinesDb.getEvalBaseline.get(sysId) as { metrics: string; evalRunId: string }
    expect(b).toBeDefined()
    expect(b.evalRunId).toBe(evalRunId)
    expect(() => JSON.parse(b.metrics)).not.toThrow()
  })

  it('compares ok (zero deltas) against the just-frozen baseline', () => {
    const cmp = compareRunToBaselines(evalRunId)
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
      evalRunId,
      frozenAt: Date.now(),
    })

    const cmp = compareRunToBaselines(evalRunId)
    expect(cmp[sysId].status).toBe('REGRESSION')
    expect(cmp[sysId].deltas?.detScoreMean).toBeLessThan(-0.1)
  })

  it('reports no-baseline for a system with no frozen row', () => {
    db.exec('DELETE FROM eval_baselines')
    const cmp = compareRunToBaselines(evalRunId)
    expect(cmp[sysId].status).toBe('no-baseline')
  })
})
