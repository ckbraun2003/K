// core/src/routes/autonomy-settings.ts — the P5 on/off front door (B4).
import type { FastifyInstance } from 'fastify'
import { AutonomyPatchBodySchema } from '@k/shared'
import { autonomySettings, setAutonomySettings } from '../config-store.js'
import { sendZodError } from './http-errors.js'

export async function autonomySettingsRoutes(app: FastifyInstance) {
  app.get('/api/autonomy', async (_req, reply) => reply.send(autonomySettings()))

  // A partial patch (empty patch and unrecognized keys both 400 via the shared
  // AutonomyPatchBodySchema — .strict() + a non-empty refine).
  app.patch('/api/autonomy', async (req, reply) => {
    const parsed = AutonomyPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    return reply.send(setAutonomySettings(parsed.data))
  })
}
