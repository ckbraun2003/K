import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { TimeseriesGroupBySchema } from '@k/shared'
import { db } from '../db.js'
import { summarizeRuns, buildTimeseries, buildQualityTimeseries, windowStartMs, aggregateRouting, type RunRow, type TimeseriesRunRow, type RoutingRunRow } from '../metrics.js'

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
const activeRunsStmt = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE status IN ('running','queued','awaiting_input')`)
// The `lead` subquery resolves each run's ORCHESTRATOR (discipline-lead) profile for the
// groupBy=lead breakdown: per run_id, the LATEST tier='orchestrator' agent_runs activation
// (ROW_NUMBER … rn=1). A run with no orchestrator activation (a plain UI run, or a
// K/Chief run) LEFT-JOINs to NULL lead_id/lead_name → grouped 'unassigned' downstream, so
// window cost stays conserved (W9b F-084). rn=1 keeps it ≤1 lead row per run (no fan-out).
const timeseriesWindowStmt = db.prepare(`
  SELECT r.created_at, r.status, r.tokens_in, r.tokens_out, r.cost_usd,
         r.provider, r.model, r.project_id, p.name AS project_name,
         ld.lead_id AS lead_id, ld.lead_name AS lead_name
  FROM runs r
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN (
    SELECT run_id, lead_id, lead_name FROM (
      SELECT ar.run_id AS run_id, ap.id AS lead_id, ap.name AS lead_name,
             ROW_NUMBER() OVER (PARTITION BY ar.run_id ORDER BY ar.created_at DESC) AS rn
      FROM agent_runs ar
      JOIN agent_profiles ap ON ap.id = ar.profile_id
      WHERE ap.tier = 'orchestrator' AND ar.run_id IS NOT NULL
    ) WHERE rn = 1
  ) ld ON ld.run_id = r.id
  WHERE r.created_at >= ?
`)
// Per-run parked_ms = Σ(awaiting_input → next-status) intervals, from the run's
// `status` events: each awaiting_input event opens a parked interval that the next
// status event (a `running` on resume, or a terminal status if killed/ended while
// parked) closes. LEAD walks the seq-ordered status events per run; we sum only the
// intervals that START at awaiting_input. Subtracting this in aggregateRouting makes
// avgLatencyMs active processing time, not wall-clock-with-operator-think-time (F-082).
const routingWindowStmt = db.prepare(`
  SELECT r.created_at, r.ended_at, r.status, r.provider, r.model, r.cost_usd,
         COALESCE(p.parked_ms, 0) AS parked_ms
  FROM runs r
  LEFT JOIN (
    SELECT run_id, SUM(next_ts - ts) AS parked_ms
    FROM (
      SELECT run_id, text, ts,
             LEAD(ts) OVER (PARTITION BY run_id ORDER BY seq) AS next_ts
      FROM events
      WHERE type = 'status'
    )
    WHERE text = 'awaiting_input' AND next_ts IS NOT NULL
    GROUP BY run_id
  ) p ON p.run_id = r.id
  WHERE r.created_at >= ?
`)

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

  // GET /api/metrics/quality?days=30 — per-day success-rate + active-latency trend.
  // Reuses the routing window rows (same status/latency source) so the trend and the
  // routing KPIs share one killed-excluded/parked-excluded definition (W9a → W9b F-087).
  app.get('/api/metrics/quality', async (req, reply) => {
    const parsed = RoutingQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    const now = Date.now()
    const rows = routingWindowStmt.all(windowStartMs(now, parsed.data.days)) as RoutingRunRow[]
    return reply.send(buildQualityTimeseries(rows, now, parsed.data.days))
  })
}
