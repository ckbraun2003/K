import type { FastifyInstance } from 'fastify'
import { HomeLayoutSchema } from '@k/shared'
import { homeLayout, setHomeLayout } from '../config-store.js'
import { sendError } from './http-errors.js'

export async function homeLayoutRoutes(app: FastifyInstance) {
  app.get('/api/settings/home-layout', async () => ({ layout: homeLayout() }))

  app.put('/api/settings/home-layout', async (req, reply) => {
    const parsed = HomeLayoutSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendError(reply, 400, parsed.error.issues[0]?.message ?? 'bad layout')
    setHomeLayout(parsed.data)
    return { layout: parsed.data }
  })
}
