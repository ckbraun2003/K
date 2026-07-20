import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getProfile, listProfiles, updateProfile } from '../profiles.js'
import { GrantError } from '../authority.js'
import { sendError, sendZodError } from './http-errors.js'

/**
 * Read-only profile inspection (F-020).
 *
 * The org's top-tier authorities — K (secretary, id `k-secretary`) and Chief — are
 * otherwise UNADDRESSABLE via REST: GET /api/orchestrators returns discipline LEADS only
 * (K/Chief/default-orchestrator fail its isLead gate), GET /api/chief/org exposes Chief
 * embedded in a page payload, and there is no way to INSPECT the K/Chief tier or charter
 * on their own.
 *
 * This surface was deliberately GET-only until C.3 (D-126) added ONE narrow write —
 * the overlay-only PATCH below. The authority ceiling stays fully enforced:
 * tier/charter/skills/tools/mcp remain unpatchable HERE (the `.strict` single-key
 * schema 400s anything else). The leads' authority PATCH lives on /api/orchestrators
 * (gated by isLead, and even there tier/charter are excluded — F-024); the
 * org-default's on /api/org-default. A read here can never become an authority write.
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

  // C.3 (D-126): the ONE profile write this surface carries — the L1.5 identity
  // overlay. Deliberately overlay-ONLY (.strict single key): authority editing stays
  // on the lead editor (orchestrators route) / is not exposed for managers at all.
  const ProfileOverlayPatchSchema = z.object({
    identityOverlay: z.string().max(20_000).nullable(),
  }).strict()

  app.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const parsed = ProfileOverlayPatchSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const updated = updateProfile(req.params.id, { identityOverlay: parsed.data.identityOverlay })
      if (!updated) return sendError(reply, 404, 'not found')
      return reply.send(updated)
    } catch (e) {
      // updateProfile re-asserts effective grants on the (untouched) authority
      // arrays; grant drift fail-closes even an overlay-only patch. That is a
      // client-actionable 400 (the sibling orchestrators-route mapping), not a 500.
      if (e instanceof GrantError) return sendError(reply, 400, e.message)
      throw e
    }
  })
}
