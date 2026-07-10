import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { TimeseriesGroupBySchema } from '@k/shared'
import type { CostRollup, RecentActuals, RecentActualsScope } from '@k/shared'
// @k/shared exports CostRollupBucketSchema (a value) but not a CostRollupBucket *type* (W0),
// so derive the element type from the frozen CostRollup shape rather than adding a shared export.
type CostRollupBucket = CostRollup['buckets'][number]
import { db } from '../db.js'
import { sendZodError } from './http-errors.js'
import { summarizeRuns, buildTimeseries, buildQualityTimeseries, windowStartMs, aggregateRouting, percentile, type RunRow, type TimeseriesRunRow, type RoutingRunRow } from '../metrics.js'

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
// P2 E-02: awaiting_plan counts as an active run — a parked plan is live work awaiting attention, not a finished run.
const activeRunsStmt = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE status IN ('running','queued','awaiting_input','awaiting_plan')`)
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
// Per-run parked_ms = Σ(park → next-status) intervals, from the run's `status`
// events: each awaiting_input OR awaiting_plan event opens a parked interval that
// the next status event (a `running` on resume, or a terminal status if
// killed/ended while parked) closes. LEAD walks the seq-ordered status events per
// run; we sum only the intervals that START at a park status. Subtracting this in
// aggregateRouting makes avgLatencyMs active processing time, not
// wall-clock-with-operator-think-time (F-082).
// P2 E-02: awaiting_plan joins awaiting_input here — plan-review wall-time is
// operator think-time, not agent latency.
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
    WHERE text IN ('awaiting_input','awaiting_plan') AND next_ts IS NOT NULL
    GROUP BY run_id
  ) p ON p.run_id = r.id
  WHERE r.created_at >= ?
`)

const DAY_MS = 86_400_000

// ── E-13 cost roll-ups (measured cost_usd only) ──────────────────────────────
const rollupProjectStmt = db.prepare(`
  SELECT COALESCE(p.id, 'none') AS key, COALESCE(p.name, 'No project') AS label,
         SUM(r.cost_usd) AS cost_usd, COUNT(*) AS runs
  FROM runs r LEFT JOIN projects p ON p.id = r.project_id
  WHERE r.created_at >= ?
  GROUP BY key ORDER BY cost_usd DESC
`)
const rollupDayStmt = db.prepare(`
  SELECT date(r.created_at / 1000, 'unixepoch') AS key, date(r.created_at / 1000, 'unixepoch') AS label,
         SUM(r.cost_usd) AS cost_usd, COUNT(*) AS runs
  FROM runs r WHERE r.created_at >= ?
  GROUP BY key ORDER BY key DESC
`)
// Lead = the run's latest tier='orchestrator' agent_runs activation (mirror metrics.ts:24-43).
const rollupLeadStmt = db.prepare(`
  WITH lead_of AS (
    SELECT ar.run_id, ap.name AS lead_name,
           ROW_NUMBER() OVER (PARTITION BY ar.run_id ORDER BY ar.created_at DESC) AS rn
    FROM agent_runs ar JOIN agent_profiles ap ON ap.id = ar.profile_id
    WHERE ap.tier = 'orchestrator' AND ar.run_id IS NOT NULL
  )
  SELECT COALESCE(l.lead_name, 'unassigned') AS key, COALESCE(l.lead_name, 'Unassigned') AS label,
         SUM(r.cost_usd) AS cost_usd, COUNT(*) AS runs
  FROM runs r LEFT JOIN lead_of l ON l.run_id = r.id AND l.rn = 1
  WHERE r.created_at >= ?
  GROUP BY key ORDER BY cost_usd DESC
`)

// ── E-13 recent actuals pools (positive-cost only; metrics.ts:351 idiom) ─────
const recentProfileStmt = db.prepare(`
  SELECT r.cost_usd AS c FROM runs r
  WHERE r.created_at >= ? AND r.cost_usd > 0
    AND EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.run_id = r.id AND ar.profile_id = ?)
`)
const recentProjectStmt = db.prepare(`SELECT r.cost_usd AS c FROM runs r WHERE r.created_at >= ? AND r.cost_usd > 0 AND r.project_id = ?`)
const recentGlobalStmt = db.prepare(`SELECT r.cost_usd AS c FROM runs r WHERE r.created_at >= ? AND r.cost_usd > 0`)

const MIN_SAMPLE = 5
const RECENT_WINDOW_DAYS = 30

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
    if (!parsed.success) return sendZodError(reply, parsed.error)
    // capture now once so the SQL bound and bucket window share one instant
    const now = Date.now()
    const rows = timeseriesWindowStmt.all(windowStartMs(now, parsed.data.days)) as TimeseriesRunRow[]
    return reply.send(buildTimeseries(rows, now, parsed.data.days, parsed.data.groupBy))
  })

  // GET /api/metrics/routing?days=30 — per-(provider,model) outcome aggregates
  app.get('/api/metrics/routing', async (req, reply) => {
    const parsed = RoutingQuerySchema.safeParse(req.query)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const now = Date.now()
    const rows = routingWindowStmt.all(windowStartMs(now, parsed.data.days)) as RoutingRunRow[]
    return reply.send(aggregateRouting(rows, now))
  })

  // GET /api/metrics/quality?days=30 — per-day success-rate + active-latency trend.
  // Reuses the routing window rows (same status/latency source) so the trend and the
  // routing KPIs share one killed-excluded/parked-excluded definition (W9a → W9b F-087).
  app.get('/api/metrics/quality', async (req, reply) => {
    const parsed = RoutingQuerySchema.safeParse(req.query)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const now = Date.now()
    const rows = routingWindowStmt.all(windowStartMs(now, parsed.data.days)) as RoutingRunRow[]
    return reply.send(buildQualityTimeseries(rows, now, parsed.data.days))
  })

  // GET /api/metrics/cost-rollup?days=14&groupBy=lead|project|day — measured cost_usd buckets
  app.get<{ Querystring: { days?: string; groupBy?: string } }>('/api/metrics/cost-rollup', async (req, reply) => {
    // Floor to an integer so windowDays honours CostRollupSchema's z.number().int()
    // (a fractional ?days=2.5 would otherwise leak a non-integer into the response).
    const days = Math.max(1, Math.min(365, Math.floor(Number(req.query.days) || 14)))
    const groupBy = (['lead', 'project', 'day'] as const).includes(req.query.groupBy as never)
      ? (req.query.groupBy as 'lead' | 'project' | 'day') : 'project'
    const since = Date.now() - days * DAY_MS
    const stmt = groupBy === 'lead' ? rollupLeadStmt : groupBy === 'day' ? rollupDayStmt : rollupProjectStmt
    const rows = stmt.all(since) as Array<{ key: string; label: string; cost_usd: number | null; runs: number }>
    const buckets: CostRollupBucket[] = rows.map(r => ({ key: r.key, label: r.label, costUsd: r.cost_usd ?? 0, runs: r.runs }))
    const rollup: CostRollup = { windowDays: days, groupBy, buckets, totalCostUsd: buckets.reduce((s, b) => s + b.costUsd, 0) }
    return reply.send(rollup)
  })

  // GET /api/metrics/recent-actuals?profileId&projectId — 30d measured median/p90, scope fallback profile→project→global
  app.get<{ Querystring: { profileId?: string; projectId?: string } }>('/api/metrics/recent-actuals', async (req, reply) => {
    const since = Date.now() - RECENT_WINDOW_DAYS * DAY_MS
    const pool = (rows: Array<{ c: number }>) => rows.map(r => r.c).sort((a, b) => a - b)
    let scope: RecentActualsScope = 'none'
    let costs: number[] = []
    if (req.query.profileId) {
      const p = pool(recentProfileStmt.all(since, req.query.profileId) as Array<{ c: number }>)
      if (p.length >= MIN_SAMPLE) { scope = 'profile'; costs = p }
    }
    if (scope === 'none' && req.query.projectId) {
      const p = pool(recentProjectStmt.all(since, req.query.projectId) as Array<{ c: number }>)
      if (p.length >= MIN_SAMPLE) { scope = 'project'; costs = p }
    }
    if (scope === 'none') {
      const p = pool(recentGlobalStmt.all(since) as Array<{ c: number }>)
      if (p.length > 0) { scope = 'global'; costs = p }
    }
    const out: RecentActuals = {
      scope, n: costs.length, windowDays: RECENT_WINDOW_DAYS,
      medianCostUsd: costs.length ? percentile(costs, 0.5) : null,   // p ∈ [0,1] — NOT 50
      p90CostUsd: costs.length ? percentile(costs, 0.9) : null,      // NOT 90 (out-of-range → NaN)
    }
    return reply.send(out)
  })
}
