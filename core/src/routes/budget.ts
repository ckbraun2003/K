// core/src/routes/budget.ts — E-17 budget governor read surface.
//   GET   /api/budget                 — measured org + per-project cap status (rolling 24h)
//   GET   /api/budget/burndown?days=N — per-day summed cost over the window (NO forecasting)
//   PATCH /api/projects/:id/budget    — set/clear a project's per-day measured cap
// All numbers are MEASURED actuals summed from runs.cost_usd — zero price×token math.
import type { FastifyInstance } from 'fastify'
import { ProjectBudgetPatchBodySchema, type CostRollup } from '@k/shared'
import { budgetStatus } from '../budget-governor.js'
import { projectsDb, db } from '../db.js'
import { sendZodError, sendError } from './http-errors.js'

// Local read (routes may add their own db.prepare per the lane contract): per-UTC-day
// summed measured cost + run count. Hoisted so it compiles once, not per request.
const burndownByDay = db.prepare(
  `SELECT CAST(created_at / 86400000 AS INTEGER) AS dayIdx,
          COALESCE(SUM(cost_usd), 0) AS spend, COUNT(*) AS n
   FROM runs WHERE created_at >= ? GROUP BY dayIdx ORDER BY dayIdx ASC`,
)

export async function budgetRoutes(app: FastifyInstance) {
  app.get('/api/budget', async (_req, reply) => reply.send(budgetStatus()))

  // Measured burn-down: per-day summed cost over the window (NO forecasting).
  app.get<{ Querystring: { days?: string } }>('/api/budget/burndown', async (req, reply) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 90)
    const since = Date.now() - days * 86_400_000
    const rows = burndownByDay.all(since) as Array<{ dayIdx: number; spend: number; n: number }>
    const buckets = rows.map(r => {
      const label = new Date(r.dayIdx * 86_400_000).toISOString().slice(0, 10)
      return { key: label, label, costUsd: r.spend, runs: r.n }
    })
    const rollup: CostRollup = {
      windowDays: days, groupBy: 'day', buckets,
      totalCostUsd: buckets.reduce((a, b) => a + b.costUsd, 0),
    }
    return reply.send(rollup)
  })

  // F-022 ordering: validate the body FIRST (→ 400), THEN check existence (→ 404).
  app.patch<{ Params: { id: string } }>('/api/projects/:id/budget', async (req, reply) => {
    const parsed = ProjectBudgetPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (!projectsDb.getProject.get(req.params.id)) return sendError(reply, 404, 'not found')
    projectsDb.setProjectBudget.run(parsed.data.budgetDailyUsd, req.params.id)
    return reply.status(204).send()
  })
}
