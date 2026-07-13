// core/src/routes/routines.ts  (Lane C fills)
import type { FastifyInstance } from 'fastify'
export async function routinesRoutes(app: FastifyInstance) {
  app.get('/api/routines', async (_req, reply) => reply.send([]))
}
