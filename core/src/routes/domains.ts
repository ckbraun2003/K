import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Domain } from '@k/shared'
import {
  listAllDomains, getDomainById, createDomain, updateDomainById, slugifyDomainName,
  DomainConflictError,
} from '../domains.js'
import { getProfile, getProfileByName, createProfile } from '../profiles.js'
import { GrantError } from '../authority.js'
import { sendError, sendZodError } from './http-errors.js'

/**
 * Domains control-plane route (C.1/C.3, D-125). Auth is the global onRequest hook.
 * The wire shape is DomainView = Domain + managerName (the UI's Domains panel renders
 * the manager by name without a second fetch). C.3 extends POST with the optional
 * `manager` block (dynamic manager creation).
 */
export type DomainView = Domain & { managerName: string | null }

function toView(d: Domain): DomainView {
  return { ...d, managerName: d.managerProfileId ? (getProfile(d.managerProfileId)?.name ?? null) : null }
}

// .trim().min(1): a whitespace-only name is a VALIDATION failure (400), never a
// stored-empty display name (quality-review m2).
const ManagerBlockSchema = z.object({
  name: z.string().trim().min(1).max(120),
  identityOverlay: z.string().max(20_000).nullable().optional(),
}).strict()

const CreateDomainSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  manager: ManagerBlockSchema.optional(),
}).strict()

const PatchDomainSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  managerProfileId: z.string().min(1).max(100).nullable().optional(),
}).strict()

export async function domainsRoutes(app: FastifyInstance) {
  app.get('/api/domains', async (_req, reply) => reply.send(listAllDomains().map(toView)))

  app.post('/api/domains', async (req, reply) => {
    const parsed = CreateDomainSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const { name, description, manager } = parsed.data
    const id = slugifyDomainName(name)
    // Un-sluggable name (e.g. '!!!') is body validation → 400, not a conflict
    // (quality-review m3; the module's throw remains as a backstop).
    if (!id) return sendError(reply, 400, 'domain name must contain letters or digits')
    // Pre-validate BOTH names before creating EITHER row (all sync — no
    // interleaving), so the domain+manager pair is effectively atomic: a manager
    // name clash can never leave an orphan domain row (or vice versa).
    if (getDomainById(id) || listAllDomains().some(d => d.name.toLowerCase() === name.trim().toLowerCase())) {
      return sendError(reply, 409, `domain "${name.trim()}" already exists`)
    }
    if (manager && getProfileByName(manager.name)) {
      return sendError(reply, 409, `profile name "${manager.name}" already in use`)
    }
    try {
      // Dynamic manager (D-125): a tier-'chief' profile — the FROZEN chief authority
      // ceiling (charter/allowlist/mcp resolved + grant-guarded by createProfile).
      const managerProfile = manager
        ? createProfile({ name: manager.name, tier: 'chief', identityOverlay: manager.identityOverlay ?? null })
        : null
      const d = createDomain({
        name, description: description ?? null,
        managerProfileId: managerProfile?.id ?? null,
      })
      return reply.status(201).send(toView(d))
    } catch (e) {
      if (e instanceof DomainConflictError) return sendError(reply, 409, e.message)
      // createProfile fail-closes on grant drift (an operator-disabled discovered
      // asset in the chief ceiling) — client-actionable 400, orchestrators-route
      // convention. Thrown before any row is written, so no orphan.
      if (e instanceof GrantError) return sendError(reply, 400, e.message)
      throw e
    }
  })

  app.patch<{ Params: { id: string } }>('/api/domains/:id', async (req, reply) => {
    const parsed = PatchDomainSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (Object.keys(parsed.data).length === 0) return sendError(reply, 400, 'empty patch')
    if (parsed.data.managerProfileId != null && !getProfile(parsed.data.managerProfileId)) {
      return sendError(reply, 400, 'unknown manager profile')
    }
    if (!getDomainById(req.params.id)) return sendError(reply, 404, 'not found')
    try {
      const updated = updateDomainById(req.params.id, parsed.data)
      if (!updated) return sendError(reply, 404, 'not found')
      return reply.send(toView(updated))
    } catch (e) {
      // A rename onto an existing name (case-insensitive) — same 409 mapping as POST
      // (quality-review M1: previously escaped as a raw SQLITE_CONSTRAINT 500).
      if (e instanceof DomainConflictError) return sendError(reply, 409, e.message)
      throw e
    }
  })
}
