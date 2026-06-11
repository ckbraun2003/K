import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { summarizeRuns, type RunRow } from '../metrics.js'

export async function metricsRoutes(app: FastifyInstance) {
  // GET /api/metrics/summary — today + active + 14-day series
  app.get('/api/metrics/summary', async (_req, reply) => {
    const rows = db.prepare(
      `SELECT created_at, status, tokens_in, tokens_out, cost_usd FROM runs`
    ).all() as RunRow[]
    return reply.send(summarizeRuns(rows, Date.now()))
  })
}
