/**
 * System routes — host prerequisite readiness (the "system doctor").
 *
 * GET /api/system/doctor detects the host tools the desktop app relies on (the
 * `claude` CLI agent engine is NOT bundled; git/node are hard prerequisites;
 * gh/ollama optional). Detection + shaping lives in system-doctor.ts — a pure
 * builder + never-throw probes, short-TTL cached — so this file is just the route.
 */

import type { FastifyInstance } from 'fastify'
import { runDoctor } from '../system-doctor.js'

export async function systemRoutes(app: FastifyInstance) {
  // GET /api/system/doctor — host prerequisite report (no secrets; short-TTL cached).
  app.get('/api/system/doctor', async (_req, reply) => {
    return reply.send(await runDoctor())
  })
}
