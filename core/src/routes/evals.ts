// F3.W2b — HTTP surface for the in-engine eval subsystem. Thin handlers over the W2a run service
// (core/src/eval/service.ts) and the DB registry (core/src/eval/store.ts): list seeded systems, start a
// DB-driven run (with a pre-flight job-count guard against empty runs), inspect runs/results, and do the
// DB-backed baseline freeze + regression compare. Business logic stays in service/store; the route only
// validates input, shapes JSON, and maps status codes — mirroring routes/skills.ts.
//
// TOKEN SAFETY: every run goes through startEvalRun, whose `dry` DEFAULTS TO TRUE. A real (spend) run
// still requires an explicit `dry: false` in the body; this route never forces a non-dry run.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { evalSystemsDb, evalCasesDb, evalRunsDb, evalResultsDb } from '../db.js'
import { loadSystemsFromDb } from '../eval/store.js'
import {
  startEvalRun,
  freezeBaselinesFromRun,
  compareRunToBaselines,
  DEFAULT_EVAL_MODELS,
  DEFAULT_EVAL_VARIANTS,
} from '../eval/service.js'

// Inline request schema (zod is already a dep; same safeParse → 400 pattern as routes/skills.ts).
const RunBodySchema = z.object({
  systems: z.array(z.string()).optional(),
  cases: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  variants: z.array(z.string()).optional(),
  dry: z.boolean().optional(),
})

interface EvalSystemListRow {
  id: string
  title: string
  job: string | null
  enabled: number
}

interface EvalRunRow {
  id: string
  status: string
  models: string
  variants: string
  systems: string
  dry: number
  totalJobs: number
  completedJobs: number
  totalCostUsd: number
  report: string | null
  error: string | null
  createdAt: number
  completedAt: number | null
}

/** Tolerant JSON column parse — a corrupt column yields null rather than a 500. */
function parseJson<T>(s: string | null): T | null {
  if (s == null) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

/** Shape one eval_runs row for the API: parse JSON columns, dry → boolean. `report` is added by callers. */
function shapeRun(r: EvalRunRow): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    dry: r.dry === 1,
    models: parseJson<string[]>(r.models) ?? [],
    variants: parseJson<string[]>(r.variants) ?? [],
    systems: parseJson<string[]>(r.systems) ?? [],
    totalJobs: r.totalJobs,
    completedJobs: r.completedJobs,
    totalCostUsd: r.totalCostUsd,
    error: r.error,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  }
}

export async function evalsRoutes(app: FastifyInstance) {
  // GET /api/evals/systems — seeded systems + each system's case count.
  app.get('/api/evals/systems', async (_req, reply) => {
    const rows = evalSystemsDb.listEvalSystems.all() as EvalSystemListRow[]
    return reply.send(
      rows.map(r => ({
        id: r.id,
        title: r.title,
        job: r.job ?? r.title,
        enabled: r.enabled === 1,
        caseCount: evalCasesDb.listEvalCasesBySystem.all(r.id).length,
      })),
    )
  })

  // POST /api/evals/run — start a DB-driven run. Pre-flight the job matrix (mirroring the runner's
  // rules) so an empty selection is rejected up front (400) instead of spawning a 0-job run.
  app.post('/api/evals/run', async (req, reply) => {
    const parsed = RunBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const body = parsed.data
    // F-014: an explicit empty `systems: []` selects NOTHING (see store.ts loadSystemsFromDb) — reject
    // it up front with a clear message rather than relying on the downstream 0-jobs path. Omitting
    // `systems` entirely is distinct: it still runs ALL systems.
    if (body.systems && body.systems.length === 0) {
      return reply.status(400).send({ error: 'no systems selected' })
    }
    const models = body.models ?? DEFAULT_EVAL_MODELS
    const variants = body.variants ?? DEFAULT_EVAL_VARIANTS
    const onlyCases = body.cases ?? null

    // Count the resulting matrix: Σ over selected systems of (filtered cases) × models × variants,
    // skipping the degraded variant for a system with no degraded prompt — exactly the runner's rules.
    const systems = loadSystemsFromDb({ only: body.systems })
    let jobs = 0
    for (const sys of systems) {
      // A system with no degraded prompt contributes no 'degraded' jobs (runner's `continue`).
      const variantsForSys = variants.filter(v => v !== 'degraded' || sys.degradedFile)
      for (const kase of sys.cases) {
        if (onlyCases && !onlyCases.includes(kase.id)) continue
        jobs += models.length * variantsForSys.length
      }
    }
    if (jobs === 0) {
      return reply.status(400).send({ error: 'no matching systems/cases' })
    }

    // `dry` stays defaulted-true by the service; the run launches in the background.
    const { evalRunId } = startEvalRun(body)
    return reply.status(202).send({ evalRunId })
  })

  // GET /api/evals/runs — recent runs, most recent first.
  app.get('/api/evals/runs', async (_req, reply) => {
    const rows = evalRunsDb.listEvalRuns.all(50) as EvalRunRow[]
    return reply.send(rows.map(shapeRun))
  })

  // GET /api/evals/runs/:id — one run, with its report JSON parsed into the response; 404 if missing.
  app.get<{ Params: { id: string } }>('/api/evals/runs/:id', async (req, reply) => {
    const row = evalRunsDb.getEvalRun.get(req.params.id) as EvalRunRow | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send({ ...shapeRun(row), report: parseJson(row.report) })
  })

  // GET /api/evals/runs/:id/results — the eval_results rows for the run (raw rows). 404s on an unknown
  // run id (consistent with the other /:id endpoints) so a misspelled id can't masquerade as an empty run.
  app.get<{ Params: { id: string } }>('/api/evals/runs/:id/results', async (req, reply) => {
    const row = evalRunsDb.getEvalRun.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(evalResultsDb.listEvalResultsByRun.all(req.params.id))
  })

  // POST /api/evals/runs/:id/freeze-baselines — freeze per-system baselines from the run report.
  app.post<{ Params: { id: string } }>('/api/evals/runs/:id/freeze-baselines', async (req, reply) => {
    const row = evalRunsDb.getEvalRun.get(req.params.id) as EvalRunRow | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    // A dry run's metrics are fabricated — freezing them would poison real regression comparisons.
    // Reject up front (400) before mutating eval_baselines.
    if (row.dry === 1) {
      return reply.status(400).send({ error: 'cannot freeze baselines from a dry run' })
    }
    return reply.send({ frozen: freezeBaselinesFromRun(req.params.id) })
  })

  // GET /api/evals/runs/:id/compare — per-system ok/REGRESSION/no-baseline vs the DB baselines.
  app.get<{ Params: { id: string } }>('/api/evals/runs/:id/compare', async (req, reply) => {
    const row = evalRunsDb.getEvalRun.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(compareRunToBaselines(req.params.id))
  })
}
