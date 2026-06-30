/**
 * F3.W1b — DB data model + file→DB seed + DB-backed loader for the ported T-EVAL harness.
 *
 * Proves: seed idempotency, DB-load ≡ file-load (the key correctness claim), eval run/result CRUD
 * with cascade delete, and baseline upsert. Operates on the shared module `db` singleton (core tests
 * run serially in one fork over one SQLite file) and wipes every eval_* row in afterAll so no seeded
 * state perturbs other suites — no other suite touches the eval_* tables.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import {
  db,
  evalSystemsDb,
  evalRunsDb,
  evalResultsDb,
  evalBaselinesDb,
} from '../src/db.js'
import { seedEvalSystems, loadSystemsFromDb } from '../src/eval/store.js'
import { loadSystems, repoRoot } from '../src/eval/systems.js'
import type { EvalCase, EvalSystem } from '../src/eval/types.js'

const root = repoRoot()

const byId = <T extends { id: string }>(arr: T[]): Record<string, T> =>
  Object.fromEntries(arr.map(x => [x.id, x]))

afterAll(() => {
  // Wipe in FK-safe order (also covered by ON DELETE CASCADE, but explicit is clearer).
  db.exec('DELETE FROM eval_baselines')
  db.exec('DELETE FROM eval_results')
  db.exec('DELETE FROM eval_runs')
  db.exec('DELETE FROM eval_cases')
  db.exec('DELETE FROM eval_systems')
})

const sysCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM eval_systems').get() as { n: number }).n
const caseCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM eval_cases').get() as { n: number }).n

describe('seedEvalSystems — idempotency', () => {
  it('seeding twice leaves system/case counts stable (no duplicates)', () => {
    const r1 = seedEvalSystems({ root })
    const sys1 = sysCount()
    const cases1 = caseCount()
    expect(sys1).toBe(r1.systems)
    expect(cases1).toBe(r1.cases)
    expect(sys1).toBeGreaterThan(0)
    expect(cases1).toBeGreaterThan(0)

    const r2 = seedEvalSystems({ root })
    expect(sysCount()).toBe(sys1)
    expect(caseCount()).toBe(cases1)
    expect(r2.systems).toBe(r1.systems)
    expect(r2.cases).toBe(r1.cases)
    expect(r2.baselines).toBe(r1.baselines)
  })

  it('a second seed updates an existing system row in place (restores mutated fields)', () => {
    seedEvalSystems({ root })
    const before = sysCount()
    db.prepare(`UPDATE eval_systems SET title = 'MUTATED', maxTurns = 999 WHERE id = 'L0'`).run()
    seedEvalSystems({ root })
    expect(sysCount()).toBe(before) // no new row
    const row = evalSystemsDb.getEvalSystem.get('L0') as { title: string; maxTurns: number }
    expect(row.title).toBe('L0 base operating prompt') // restored from the registry file
    expect(row.maxTurns).toBe(12)
  })
})

describe('loadSystemsFromDb — equivalent to loadSystems (file loader)', () => {
  it('returns systems + cases structurally equal to the file loader for the seeded ids', () => {
    seedEvalSystems({ root })
    const fileSystems = loadSystems({ root })
    const ids = fileSystems.map(s => s.id)
    const dbSystems = loadSystemsFromDb({ root, only: ids })

    expect(dbSystems.length).toBe(fileSystems.length)

    const fileById = byId(fileSystems)
    const dbById = byId(dbSystems)
    for (const id of ids) {
      const f: EvalSystem = fileById[id]
      const g: EvalSystem | undefined = dbById[id]
      expect(g, `system ${id} present in DB load`).toBeDefined()
      if (!g) continue

      expect(g.title).toBe(f.title)
      expect(g.job).toBe(f.job)
      expect(g.promptFile).toBe(f.promptFile)
      expect(g.degradedFile).toBe(f.degradedFile)
      expect([...g.allowedTools].sort()).toEqual([...f.allowedTools].sort())
      expect([...g.disallowedTools].sort()).toEqual([...f.disallowedTools].sort())
      expect(g.maxTurns).toBe(f.maxTurns)
      expect(g.rubricText).toBe(f.rubricText)

      // cases compared order-independently on id/input/checks/fixture
      const fCases = byId(f.cases)
      const gCases = byId(g.cases)
      expect(Object.keys(gCases).sort()).toEqual(Object.keys(fCases).sort())
      for (const cid of Object.keys(fCases)) {
        const fc: EvalCase = fCases[cid]
        const gc: EvalCase = gCases[cid]
        expect(gc.input).toBe(fc.input)
        expect(gc.fixture ?? null).toEqual(fc.fixture ?? null)
        expect(gc.checks ?? []).toEqual(fc.checks ?? [])
        // every case field the runner/graders/judge actually read must survive the DB round-trip
        expect(gc.title ?? null).toBe(fc.title ?? null)
        expect(gc.allowedTools ?? null).toEqual(fc.allowedTools ?? null)
        expect(gc.refusalExpected ?? null).toBe(fc.refusalExpected ?? null)
        expect(gc.judge ?? null).toBe(fc.judge ?? null)
        expect(gc.maxTurns ?? null).toBe(fc.maxTurns ?? null)
        expect(gc.timeoutMs ?? null).toBe(fc.timeoutMs ?? null)
      }
    }
  })

  it('round-trips judge:false (judgeEnabled 0 → c.judge === false; NULL → undefined)', () => {
    // No seeded case sets judge:false today, so force one and prove the 0 → false reconstruction —
    // the runner's `kase.judge === false` judge-disable path depends on this exact bit surviving.
    seedEvalSystems({ root })
    db.prepare(`UPDATE eval_cases SET judgeEnabled = 0 WHERE id = 'L0-01'`).run()
    const sys = loadSystemsFromDb({ root, only: ['L0'] })[0]
    expect(sys.cases.find(c => c.id === 'L0-01')?.judge).toBe(false)
    // a case with NULL judgeEnabled (the default) must reconstruct as `undefined`, not false, so the
    // runner only disables the judge when the author EXPLICITLY set judge:false.
    expect(sys.cases.find(c => c.id !== 'L0-01')?.judge).toBeUndefined()
  })

  it('honors the `only` filter', () => {
    seedEvalSystems({ root })
    const one = loadSystemsFromDb({ root, only: ['L0'] })
    expect(one.map(s => s.id)).toEqual(['L0'])
  })
})

describe('eval_runs / eval_results — CRUD + cascade', () => {
  it('inserts a run + results, updates the run, then cascade-deletes results with the run', () => {
    const runId = uuid()
    evalRunsDb.insertEvalRun.run({
      id: runId,
      status: 'running',
      models: JSON.stringify(['sonnet']),
      variants: JSON.stringify(['real', 'degraded']),
      systems: JSON.stringify(['L0']),
      dry: 0,
      totalJobs: 3,
      completedJobs: 0,
      totalCostUsd: 0,
      report: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    })

    for (let i = 0; i < 3; i++) {
      evalResultsDb.insertEvalResult.run({
        id: uuid(),
        evalRunId: runId,
        systemId: 'L0',
        caseId: `L0-0${i + 1}`,
        model: 'sonnet',
        variant: i % 2 === 0 ? 'real' : 'degraded',
        detPass: 1,
        detScore: 0.9,
        formatScore: 0.75,
        judgeOverall: 0.8,
        judgeVerdict: 'pass',
        refusalCorrect: null,
        costUsd: 0.01,
        ms: 1234,
        numTurns: 5,
        error: null,
        raw: JSON.stringify({ ok: true }),
        createdAt: Date.now(),
      })
    }

    expect(evalResultsDb.listEvalResultsByRun.all(runId).length).toBe(3)

    evalRunsDb.updateEvalRunProgress.run({ id: runId, completedJobs: 3, totalCostUsd: 0.03 })
    evalRunsDb.updateEvalRunStatus.run({
      id: runId,
      status: 'done',
      report: JSON.stringify({ overall: { systems: 1 } }),
      error: null,
      completedAt: Date.now(),
    })
    const run = evalRunsDb.getEvalRun.get(runId) as {
      status: string
      completedJobs: number
      totalCostUsd: number
      report: string
    }
    expect(run.status).toBe('done')
    expect(run.completedJobs).toBe(3)
    expect(run.totalCostUsd).toBeCloseTo(0.03)
    expect((JSON.parse(run.report) as { overall: { systems: number } }).overall.systems).toBe(1)

    // delete the run → results cascade away
    evalRunsDb.deleteEvalRun.run(runId)
    expect(evalRunsDb.getEvalRun.get(runId)).toBeUndefined()
    expect(evalResultsDb.listEvalResultsByRun.all(runId).length).toBe(0)
  })
})

describe('eval_baselines — freeze/upsert', () => {
  it('freezes a baseline and re-freezes it in place (no duplicate)', () => {
    seedEvalSystems({ root }) // L0 exists (FK target for the baseline)

    evalBaselinesDb.upsertEvalBaseline.run({
      systemId: 'L0',
      metrics: JSON.stringify({ real: { judgeMean: 0.5 } }),
      evalRunId: null,
      frozenAt: Date.now(),
    })
    let b = evalBaselinesDb.getEvalBaseline.get('L0') as { metrics: string }
    expect((JSON.parse(b.metrics) as { real: { judgeMean: number } }).real.judgeMean).toBe(0.5)

    evalBaselinesDb.upsertEvalBaseline.run({
      systemId: 'L0',
      metrics: JSON.stringify({ real: { judgeMean: 0.9 } }),
      evalRunId: null,
      frozenAt: Date.now(),
    })
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM eval_baselines WHERE systemId = 'L0'`).get() as {
        n: number
      }
    ).n
    expect(count).toBe(1)
    b = evalBaselinesDb.getEvalBaseline.get('L0') as { metrics: string }
    expect((JSON.parse(b.metrics) as { real: { judgeMean: number } }).real.judgeMean).toBe(0.9)
  })
})
