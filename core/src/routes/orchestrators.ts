import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { OrchestratorRosterPayload } from '@k/shared'
import { GrantError } from '../authority.js'
import { getProfile, listProfiles, updateProfile } from '../profiles.js'
import { assembleLead, isLead, rosterVitals } from './org-shared.js'
import { sendError, describePatchRejection } from './http-errors.js'
import { resolveAvailableModels, availableModelIds } from '../models.js'

/**
 * Orchestrators control-plane route (P5.3a) — the roster + detail + per-lead
 * authority editor for the five discipline leads (orchestrator-tier profiles, minus
 * the generic default-orchestrator). The roster REUSES routes/org-shared.ts::rosterVitals
 * (slim) and the detail REUSES assembleLead, so a lead's live shape is derived from
 * exactly one authority (the same one the Chief org route uses). Every mutation is
 * delegated to profiles.ts::updateProfile — which re-resolves the charter's authority
 * and runs the mcp↔allowlist grant guard fail-closed. The SEAM: an ungranted-MCP-mount
 * patch makes updateProfile THROW; this route maps THAT case to a 400 and NEVER bypasses
 * the guard (a non-guard fault re-throws → Fastify 500, not a mislabelled 400).
 */

// The two fail-closed client-error guards — assertMcpGrants ("mounting ≠ granting",
// D-034) and assertTierCeiling (the B1 tier ceiling) — throw the typed GrantError
// (authority.ts). Those are the ONLY updateProfile throws that are client errors (a
// bad patch); anything else (a missing charter asset, a DB fault) is a server fault
// → re-throw → 500. The PATCH handler below maps on `instanceof GrantError`.

// The mutable per-lead patch. All fields optional (partial patch); `.strict()` so an
// unknown key is a 400 (a typo can't silently no-op). Deliberately EXCLUDES tier/charter:
// the UI edits neither, and a tier patch could flip a lead to a non-orchestrator — making
// it fail `isLead` and vanish from its own management surface (unmanageable via itself).
// Authority editing here means skills/tools/mcp/model only; tier/charter moves are a
// separate, guarded concern (deferred). An empty body is rejected below — a PATCH must
// actually change something.
const OrchestratorPatchSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    defaultModel: z.string().nullable().optional(), // null = clear to runtime default
  })
  .strict()

export async function orchestratorsRoutes(app: FastifyInstance) {
  // GET /api/orchestrators — the slim roster. ONE bounded activation scan per lead
  // (via rosterVitals) → a slim entry; the delegate-events fetch is deliberately NOT
  // paid here (only the detail view renders the tree).
  app.get('/api/orchestrators', async (_req, reply) => {
    const leads = listProfiles().filter(isLead).map(rosterVitals)
    const activeLeads = leads.filter(l => l.live).length
    const payload: OrchestratorRosterPayload = { leads, activeLeads }
    return reply.send(payload)
  })

  // GET /api/orchestrators/:id — the full ChiefOrgLead detail for one lead (reused
  // detail wire type). 404 for an unknown id OR a non-lead profile (chief / secretary
  // / the generic default-orchestrator).
  app.get<{ Params: { id: string } }>('/api/orchestrators/:id', async (req, reply) => {
    const profile = getProfile(req.params.id)
    if (!profile || !isLead(profile)) return sendError(reply, 404, 'not found')
    return reply.send(assembleLead(profile))
  })

  // PATCH /api/orchestrators/:id — edit a lead's authority (skills/tools/mcp/model;
  // tier & charter are NOT patchable here — see the .strict() schema above). Validate
  // the patch (400), confirm the target is a lead (404), then let
  // updateProfile apply it under the grant guard. SEAM: the guard's throw → 400 (never
  // bypassed); a null return (race) → 404.
  app.patch<{ Params: { id: string } }>('/api/orchestrators/:id', async (req, reply) => {
    const parsed = OrchestratorPatchSchema.safeParse(req.body)
    // Name the offending field(s) (F-024) instead of the opaque "invalid patch": a PATCH that
    // tries to move tier/charter (the deliberately-excluded, immutable fields) now hears WHY it
    // was rejected — mirroring the quality of the GrantError ceiling messages.
    if (!parsed.success) return sendError(reply, 400, describePatchRejection(parsed.error, ['tier', 'charter']))
    if (Object.keys(parsed.data).length === 0) {
      return sendError(reply, 400, 'empty patch')
    }
    // defaultModel must be an available model id — Claude KNOWN_MODELS ∪ whatever
    // Ollama models are actually installed (usability-access C.2; was Claude-only
    // isKnownModel). null explicitly CLEARS the override back to the runtime
    // default. '' normalizes to that same clear-sentinel FIRST — it is the storage
    // encoding of "no override" (db.ts rowToAgentProfile), so it must clear, never 400.
    if (parsed.data.defaultModel === '') parsed.data.defaultModel = null
    if (parsed.data.defaultModel != null) {
      const avail = availableModelIds(await resolveAvailableModels())
      if (!avail.has(parsed.data.defaultModel)) return sendError(reply, 400, 'unknown model')
    }

    const existing = getProfile(req.params.id)
    if (!existing || !isLead(existing)) return sendError(reply, 404, 'not found')

    try {
      const updated = updateProfile(req.params.id, parsed.data)
      if (!updated) return sendError(reply, 404, 'not found')
      return reply.send(updated)
    } catch (e) {
      // ONLY the typed GrantError (the two fail-closed guards: assertMcpGrants —
      // "mounting ≠ granting" — and assertTierCeiling — the B1 tier ceiling) is a
      // client error: a 400, with the row UNCHANGED (updateProfile threw before the
      // UPDATE). Any OTHER throw is a server fault — re-throw so Fastify answers 500
      // instead of mislabelling it a 400.
      if (e instanceof GrantError) return sendError(reply, 400, e.message)
      throw e
    }
  })
}
