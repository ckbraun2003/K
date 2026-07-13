// core/src/routes/retry-metrics.ts  (Lane D fills)
import type { FastifyInstance } from 'fastify'
import { retryRateSeries } from '../retry-metrics.js'
export async function retryMetricsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>('/api/metrics/retry-rate', async (req, reply) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 90)
    return reply.send(retryRateSeries(days))
  })
}
