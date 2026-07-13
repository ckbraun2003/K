// core/src/routes/budget.ts  (Lane A fills status computation + burndown)
import type { FastifyInstance } from 'fastify'
import type { BudgetStatus } from '@k/shared'
export async function budgetRoutes(app: FastifyInstance) {
  app.get('/api/budget', async (_req, reply) => {
    const stub: BudgetStatus = { windowHours: 24, org: { capUsd: null, spentUsd: 0, warnPct: 0.8, state: 'ok' }, projects: [], generatedAt: Date.now() }
    return reply.send(stub)
  })
}
