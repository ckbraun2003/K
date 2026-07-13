// core/src/routes/autonomy-settings.ts  (Lane B fills PATCH validation/behavior)
import type { FastifyInstance } from 'fastify'
import { autonomySettings } from '../config-store.js'
export async function autonomySettingsRoutes(app: FastifyInstance) {
  app.get('/api/autonomy', async (_req, reply) => reply.send(autonomySettings()))
}
