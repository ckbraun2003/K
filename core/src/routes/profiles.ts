import type { FastifyInstance } from 'fastify'
import { getProfile, listProfiles } from '../profiles.js'
import { sendError } from './http-errors.js'

/**
 * Read-only profile inspection (F-020).
 *
 * The org's top-tier authorities — K (secretary, id `k-secretary`) and Chief — are
 * otherwise UNADDRESSABLE via REST: GET /api/orchestrators returns discipline LEADS only
 * (K/Chief/default-orchestrator fail its isLead gate), GET /api/chief/org exposes Chief
 * embedded in a page payload, and there is no way to INSPECT the K/Chief tier or charter
 * on their own.
 *
 * This surface is deliberately GET-only. It opens NO write path, so the authority ceiling
 * stays fully enforced: tier/charter remain unpatchable everywhere. The leads' authority
 * PATCH lives on /api/orchestrators (gated by isLead, and even there tier/charter are
 * excluded — F-024); the org-default's on /api/org-default; K and Chief have NO PATCH at
 * all. A read here can never become a write.
 */
export async function profilesRoutes(app: FastifyInstance) {
  // GET /api/profiles — every durable profile (read-only, seed order).
  app.get('/api/profiles', async (_req, reply) => {
    return reply.send(listProfiles())
  })

  // GET /api/profiles/:id — any single profile, read-only (K, Chief, a lead, the
  // org-default — anything). 404 for an unknown id.
  app.get<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const profile = getProfile(req.params.id)
    if (!profile) return sendError(reply, 404, 'not found')
    return reply.send(profile)
  })
}
