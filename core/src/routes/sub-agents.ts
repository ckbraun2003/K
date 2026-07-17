import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { listSubAgents, createSubAgent, updateSubAgent, deleteSubAgent } from '../sub-agents.js'
import { sendError, sendZodError } from './http-errors.js'

/**
 * Sub-agent worker REST surface (Orchestration Program Phase 2, Lane B Task
 * B.2) — the operator's CRUD entrance onto the registry (core/src/sub-agents.ts,
 * a FROZEN W0 interface this route only ever CONSUMES, never edits). Two
 * sources merge under GET: K-native (source:'k', parsed live from disk,
 * read-only) and operator (source:'operator', full CRUD).
 *
 * Mutations are operator-only: the registry throws when a K-native id/name is
 * targeted ("... is a K-native worker — read-only ..." / a name collision),
 * and mapSubAgentError classifies that as 403 (not 400/404) — the request was
 * well-formed, the target is just not editable. "Fork to edit" is the sanctioned
 * path: POST with `cloneFrom` copies a source entry's fields into a brand-new
 * operator row (mirrors the Skill Creator / capability-catalog fork pattern).
 *
 * Auth is the global onRequest hook (index.ts) — no per-route guard. Body
 * validation (400) always precedes the registry's existence/read-only checks
 * (403/404), per the F-022 ordering convention (http-errors.ts).
 */

// name mirrors SubAgentDefSchema (@k/shared): max 64. role mirrors it too: max 500.
// allowedTools/mcpServers/skills are plain string-id arrays (no shape validation here —
// the registry itself is source of truth for what a valid tool/mcp/skill id looks like,
// same latitude AgentProfile's own patch routes give those arrays).
const NAME = z.string().min(1).max(64)
const ROLE = z.string().min(1).max(500)
const PROMPT = z.string().min(1)
const STRING_ARRAY = z.array(z.string())

// POST /api/sub-agents — plain create (name+role+prompt required) OR a fork/clone
// (cloneFrom set: role/prompt/model/tool-lists fall back to the cloned source's own
// fields, so the caller only has to name the fork and change what it wants to change).
const CreateBodySchema = z
  .object({
    name: NAME,
    role: ROLE.optional(),
    model: z.string().nullable().optional(),
    allowedTools: STRING_ARRAY.optional(),
    mcpServers: STRING_ARRAY.optional(),
    skills: STRING_ARRAY.optional(),
    prompt: PROMPT.optional(),
    enabled: z.boolean().optional(),
    cloneFrom: z.string().min(1).optional(),
  })
  .strict()
  .refine(b => b.cloneFrom !== undefined || (b.role !== undefined && b.prompt !== undefined), {
    message: 'role and prompt are required unless cloneFrom is set',
  })

const UpdateBodySchema = z
  .object({
    name: NAME.optional(),
    role: ROLE.optional(),
    model: z.string().nullable().optional(),
    allowedTools: STRING_ARRAY.optional(),
    mcpServers: STRING_ARRAY.optional(),
    skills: STRING_ARRAY.optional(),
    prompt: PROMPT.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

/** Classify an error the frozen registry threw: "K-native worker" (read-only target,
 *  including a name-collision attempt) → 403; "not found" (no operator row) → 404;
 *  a raw DB UNIQUE-constraint failure (operator name collision) → 409; anything else
 *  is unexpected → log + 500. */
function mapSubAgentError(reply: FastifyReply, req: FastifyRequest, e: unknown): FastifyReply {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('K-native worker')) return sendError(reply, 403, msg)
  if (msg.includes('not found')) return sendError(reply, 404, msg)
  if (msg.toLowerCase().includes('unique constraint')) return sendError(reply, 409, 'a sub-agent with that name already exists')
  req.log.error(e)
  return sendError(reply, 500, 'sub-agent operation failed')
}

export async function subAgentsRoutes(app: FastifyInstance) {
  // GET /api/sub-agents — every worker, K-native first (stable), then operator rows.
  app.get('/api/sub-agents', async (_req, reply) => reply.send(listSubAgents()))

  // GET /api/sub-agents/:id — one worker by id (either source). 404 unknown.
  app.get<{ Params: { id: string } }>('/api/sub-agents/:id', async (req, reply) => {
    const found = listSubAgents().find(a => a.id === req.params.id)
    if (!found) return sendError(reply, 404, 'not found')
    return reply.send(found)
  })

  // POST /api/sub-agents — create (plain) or fork (cloneFrom). Body 400 → clone-source
  // 404 → K-native-name-collision 403 → 201.
  app.post('/api/sub-agents', async (req, reply) => {
    const parsed = CreateBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const b = parsed.data

    let base: ReturnType<typeof listSubAgents>[number] | undefined
    if (b.cloneFrom !== undefined) {
      base = listSubAgents().find(a => a.id === b.cloneFrom)
      if (!base) return sendError(reply, 404, `clone source not found: ${b.cloneFrom}`)
    }

    try {
      const created = createSubAgent({
        name: b.name,
        role: b.role ?? base!.role,
        model: b.model !== undefined ? b.model : (base?.model ?? null),
        allowedTools: b.allowedTools ?? base?.allowedTools ?? [],
        mcpServers: b.mcpServers ?? base?.mcpServers ?? [],
        skills: b.skills ?? base?.skills ?? [],
        prompt: b.prompt ?? base!.prompt,
        enabled: b.enabled,
      })
      return reply.status(201).send(created)
    } catch (e) {
      return mapSubAgentError(reply, req, e)
    }
  })

  // PATCH /api/sub-agents/:id — operator-only (403 on a K-native id). Body 400 first.
  app.patch<{ Params: { id: string } }>('/api/sub-agents/:id', async (req, reply) => {
    const parsed = UpdateBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      return reply.send(updateSubAgent(req.params.id, parsed.data))
    } catch (e) {
      return mapSubAgentError(reply, req, e)
    }
  })

  // DELETE /api/sub-agents/:id — operator-only (403 on a K-native id). 404 unknown operator id.
  app.delete<{ Params: { id: string } }>('/api/sub-agents/:id', async (req, reply) => {
    try {
      deleteSubAgent(req.params.id)
      return reply.status(204).send()
    } catch (e) {
      return mapSubAgentError(reply, req, e)
    }
  })
}
