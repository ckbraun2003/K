import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { TimeseriesGroupBySchema } from '@k/shared'
import { db } from '../db.js'
import { summarizeRuns, buildTimeseries, windowStartMs, aggregateRouting, type RunRow, type TimeseriesRunRow, type RoutingRunRow } from '../metrics.js'

const TimeseriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  groupBy: TimeseriesGroupBySchema.default('project'),
})

const RoutingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

// Prepared once and reused (better-sqlite3 compiles on prepare) — matches db.ts.
const summaryWindowStmt = db.prepare(
  `SELECT created_at, status, tokens_in, tokens_out, cost_usd FROM runs WHERE created_at >= ?`
)
const totalRunsStmt = db.prepare(`SELECT COUNT(*) AS c FROM runs`)
const activeRunsStmt = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE status IN ('running','queued')`)
const timeseriesWindowStmt = db.prepare(`
  SELECT r.created_at, r.status, r.tokens_in, r.tokens_out, r.cost_usd,
         r.provider, r.model, r.project_id, p.name AS project_name
  FROM runs r LEFT JOIN projects p ON p.id = r.project_id
  WHERE r.created_at >= ?
`)
const routingWindowStmt = db.prepare(
  `SELECT created_at, ended_at, status, provider, model, cost_usd FROM runs WHERE created_at >= ?`
)

export async function metricsRoutes(app: FastifyInstance) {
  // GET /api/metrics/summary — today + active + 14-day series
  app.get('/api/metrics/summary', async (_req, reply) => {
    const now = Date.now()
    // Bound the daily scan to the 14-day window; lifetime/active come from COUNT queries
    const rows = summaryWindowStmt.all(windowStartMs(now, 14)) as RunRow[]
    // COUNT(*) always returns exactly one row — the cast is safe
    const { c: totalRuns } = totalRunsStmt.get() as { c: number }
    const { c: activeRuns } = activeRunsStmt.get() as { c: number }
    return reply.send(summarizeRuns(rows, now, { totalRuns, activeRuns }))
  })

  // GET /api/metrics/timeseries?days=30&groupBy=project|model
  app.get('/api/metrics/timeseries', async (req, reply) => {
    const parsed = TimeseriesQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    // capture now once so the SQL bound and bucket window share one instant
    const now = Date.now()
    const rows = timeseriesWindowStmt.all(windowStartMs(now, parsed.data.days)) as TimeseriesRunRow[]
    return reply.send(buildTimeseries(rows, now, parsed.data.days, parsed.data.groupBy))
  })

  // GET /api/metrics/routing?days=30 — per-(provider,model) outcome aggregates
  app.get('/api/metrics/routing', async (req, reply) => {
    const parsed = RoutingQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    const now = Date.now()
    const rows = routingWindowStmt.all(windowStartMs(now, parsed.data.days)) as RoutingRunRow[]
    return reply.send(aggregateRouting(rows, now))
  })
}
