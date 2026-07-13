// core/src/routes/retry-metrics.ts  (Lane D fills)
import type { FastifyInstance } from 'fastify'
export async function retryMetricsRoutes(app: FastifyInstance) {
  app.get('/api/metrics/retry-rate', async (_req, reply) => reply.send({ windowDays: 14, points: [], overallRate: 0 }))
}
