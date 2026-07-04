/**
 * F3.W2b — Eval HTTP route tests (core/src/routes/evals.ts).
 *
 * ALL DRY — zero token spend, NO real claude.exe dispatch. Builds the real Fastify app in-process
 * (buildApp from index.ts) and drives it with app.inject — no socket, no scheduler. Seeds the DB
 * registry via seedEvalSystems({root}) so the eval surface has real systems/cases to run, and wipes
 * every eval_* row before/after (shared K_DATA_DIR singleton, serial single-fork — see vitest.config.ts).
 *
 * The live POST /api/evals/run path kicks off a background DRY run; the HTTP test asserts only the 202 +
 * the synchronously-inserted durable row (the async finalize is proven deterministically in
 * eval-service.test.ts via `completed`). The GET-by-id / results / freeze / compare endpoints are
 * exercised against a SYNTHETIC completed run inserted directly via the repos — deterministic, no spend.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, evalRunsDb, evalResultsDb, evalBaselinesDb } from '../src/db.js'
import { seedEvalSystems, loadSystemsFromDb } from '../src/eval/store.js'
import { repoRoot } from '../src/eval/systems.js'
import type { EvalReport, SystemMetrics } from '../src/eval/types.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const root = repoRoot()

function wipe(): void {
  db.exec('DELETE FROM eval_baselines')
  db.exec('DELETE FROM eval_results')
  db.exec('DELETE FROM eval_runs')
  db.exec('DELETE FROM eval_cases')
  db.exec('DELETE FROM eval_systems')
}

let app: FastifyInstance
let firstSys: string
let firstCase: string
// Background dry runs kicked off via POST /run — drained in teardown before the wipe.
const startedRunIds: string[] = []

function makeMetrics(): SystemMetrics {
  return {
    n: { real: 1, degraded: 1 },
    real: {
      judgeMean: 0.9, detPassRate: 1, detScoreMean: 0.95, formatMean: 1, refusalCorrectRate: null,
      costUsd: 0, latencyMsMean: 1000, turnsMean: 2, tokensInSum: null, tokensOutSum: null,
    },
    degraded: { judgeMean: 0.3, detPassRate: 0, detScoreMean: 0.2 },
    discriminationJudge: 0.6,
    discriminationDet: 0.75,
    discriminationPass: true,
    perModel: {},
  }
}

/**
 * Insert a synthetic COMPLETED run with a stored report keyed by a REAL seeded system id (eval_baselines
 * has an FK to eval_systems, and FKs are ON) plus its two result rows. `dry` controls the run's dry flag
 * (a dry run cannot be frozen). Returns the run id.
 */
function insertSyntheticRun(sysId: string, caseId: string, dry = true): string {
  const id = uuid()
  const report: EvalReport = {
    runId: id,
    generatedAt: new Date().toISOString(),
    models: ['sonnet'],
    variants: ['real', 'degraded'],
    dry,
    overall: {
      systems: 1, models: ['sonnet'], totalRecords: 2, totalCostUsd: 0,
      realJudgeMean: 0.9, realDetPassRate: 1, discriminationPassCount: 1,
      discriminationThreshold: 0.15, detDiscriminationThreshold: 0.1,
    },
    perSystem: { [sysId]: makeMetrics() },
    regression: {},
    baselinesFrozen: [],
  }
  evalRunsDb.insertEvalRun.run({
    id, status: 'done', models: JSON.stringify(['sonnet']), variants: JSON.stringify(['real', 'degraded']),
    systems: JSON.stringify([sysId]), dry: dry ? 1 : 0, totalJobs: 2, completedJobs: 2, totalCostUsd: 0,
    report: JSON.stringify(report), error: null, createdAt: Date.now(), completedAt: Date.now(),
  })
  for (const variant of ['real', 'degraded'] as const) {
    evalResultsDb.insertEvalResult.run({
      id: uuid(), evalRunId: id, systemId: sysId, caseId, model: 'sonnet', variant,
      detPass: 1, detScore: 0.95, formatScore: 1, judgeOverall: null, judgeVerdict: null,
      refusalCorrect: null, costUsd: 0, ms: 1000, numTurns: 2, error: null,
      raw: JSON.stringify({ system: sysId, caseId, model: 'sonnet', variant }), createdAt: Date.now(),
    })
  }
  return id
}

/** Teardown-only drain: wait until a background run reaches a terminal status before we wipe its rows. */
async function waitTerminal(id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = evalRunsDb.getEvalRun.get(id) as { status?: string } | undefined
    if (!row || ['done', 'error', 'killed'].includes(row.status ?? '')) return
    await new Promise(r => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  wipe()
  seedEvalSystems({ root }) // populate the DB registry the routes read from
  const sys = loadSystemsFromDb({ root })[0]
  firstSys = sys.id
  firstCase = sys.cases[0].id

  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  for (const id of startedRunIds) await waitTerminal(id)
  wipe()
  await app.close()
})

describe('GET /api/evals/systems', () => {
  it('200 lists seeded systems, each with caseCount > 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/systems', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const systems = res.json() as Array<{ id: string; caseCount: number; enabled: boolean }>
    expect(Array.isArray(systems)).toBe(true)
    expect(systems.length).toBeGreaterThan(0)
    const me = systems.find(s => s.id === firstSys)
    expect(me).toBeDefined()
    expect(me!.caseCount).toBeGreaterThan(0)
    expect(me!.enabled).toBe(true)
  })
})

describe('POST /api/evals/run', () => {
  it('202 + { evalRunId } and inserts a durable eval_runs row for a matching selection', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/evals/run', headers: AUTH,
      payload: { dry: true, systems: [firstSys], cases: [firstCase] },
    })
    expect(res.statusCode).toBe(202)
    const { evalRunId } = res.json() as { evalRunId: string }
    expect(typeof evalRunId).toBe('string')
    startedRunIds.push(evalRunId)
    // the durable row is inserted synchronously before startEvalRun returns
    expect(evalRunsDb.getEvalRun.get(evalRunId)).toBeDefined()
  })

  it('400 when the selection matches no jobs', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/evals/run', headers: AUTH,
      payload: { systems: ['__nope__'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/no matching/i)
  })

  it('F-014: 400 when `systems` is present but EMPTY (must not silently fan out to all)', async () => {
    // Pre-fix `systems: []` loaded every system (192-job real-spend risk) → 202. Post-fix it is
    // rejected up front with a clear message, and NO background run is started.
    const res = await app.inject({
      method: 'POST', url: '/api/evals/run', headers: AUTH,
      payload: { systems: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/no systems/i)
  })

  it('F-014: 202 when `systems` is OMITTED — omitted still runs ALL (scoped here by a case filter)', async () => {
    // Distinguishes omitted (run all) from empty (run none). Scope to one case so the dry run is tiny.
    const res = await app.inject({
      method: 'POST', url: '/api/evals/run', headers: AUTH,
      payload: { dry: true, cases: [firstCase] },
    })
    expect(res.statusCode).toBe(202)
    const { evalRunId } = res.json() as { evalRunId: string }
    startedRunIds.push(evalRunId)
  })
})

describe('run inspection + baseline freeze/compare (synthetic completed run)', () => {
  let runId: string // DRY run — inspected + freeze-rejected
  let nonDryRunId: string // NON-DRY run — the legal freeze/compare-ok target
  beforeAll(() => {
    runId = insertSyntheticRun(firstSys, firstCase, true)
    nonDryRunId = insertSyntheticRun(firstSys, firstCase, false)
    // Start this block from a clean baseline slate: seedEvalSystems() may have frozen a baseline for
    // firstSys from testing/eval/baselines/<id>.json, which would make the no-baseline case return 'ok'.
    db.exec('DELETE FROM eval_baselines')
  })

  it('GET /api/evals/runs lists the run (status done, dry true)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/runs', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const runs = res.json() as Array<{ id: string; status: string; dry: boolean }>
    const me = runs.find(r => r.id === runId)
    expect(me).toBeDefined()
    expect(me!.status).toBe('done')
    expect(me!.dry).toBe(true)
  })

  it('GET /api/evals/runs/:id returns the run with its report JSON parsed', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/evals/runs/${runId}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { report: { perSystem: Record<string, unknown> } | null }
    expect(body.report).not.toBeNull()
    expect(body.report!.perSystem[firstSys]).toBeDefined()
  })

  it('GET /api/evals/runs/:id → 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/runs/__missing__', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/evals/runs/:id/results returns the run result rows', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/evals/runs/${runId}/results`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ evalRunId: string; variant: string }>
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.evalRunId === runId)).toBe(true)
    expect(rows.map(r => r.variant).sort()).toEqual(['degraded', 'real'])
  })

  it('GET /api/evals/runs/:id/results → 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/runs/__missing__/results', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/evals/runs/:id/compare → no-baseline before any freeze', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/evals/runs/${runId}/compare`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const cmp = res.json() as Record<string, { status: string }>
    expect(cmp[firstSys].status).toBe('no-baseline')
  })

  it('POST /api/evals/runs/:id/freeze-baselines → 400 for a DRY run (fabricated metrics)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/evals/runs/${runId}/freeze-baselines`, headers: AUTH,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/dry/i)
    // the rejected freeze must not have written a baseline
    expect(evalBaselinesDb.getEvalBaseline.get(firstSys)).toBeUndefined()
  })

  it('POST /api/evals/runs/:id/freeze-baselines → { frozen: [system] } for a NON-DRY run', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/evals/runs/${nonDryRunId}/freeze-baselines`, headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    const { frozen } = res.json() as { frozen: string[] }
    expect(frozen).toContain(firstSys)
  })

  it('GET /api/evals/runs/:id/compare → ok against the just-frozen baseline', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/evals/runs/${nonDryRunId}/compare`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const cmp = res.json() as Record<string, { status: string }>
    expect(cmp[firstSys].status).toBe('ok')
  })

  it('POST /api/evals/runs/:id/freeze-baselines → 404 for an unknown id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/evals/runs/__missing__/freeze-baselines', headers: AUTH,
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/evals/runs/:id/compare → 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/runs/__missing__/compare', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})

describe('auth', () => {
  it('401 without the Bearer header (route is behind the global auth hook)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/evals/systems' })
    expect(res.statusCode).toBe(401)
  })
})
