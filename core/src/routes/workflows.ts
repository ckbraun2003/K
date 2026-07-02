import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getWorkflowDef, listWorkflowDefs, updateWorkflowDef } from '../workflow-defs.js'

/**
 * Named-workflow definitions route (P5.3b, D-047) — the list + detail + editor for the
 * operator-editable workflow TEMPLATES (workflow_definitions). This is the DB entity
 * distinct from the @k/shared WorkflowDefinition diagram type. Every mutation is delegated
 * to workflow-defs.ts::updateWorkflowDef (read-merge-write). Mirrors routes/orchestrators.ts:
 * zod `.strict()` so an unknown key is a 400, empty patch is a 400, unknown id is a 404.
 */

// The mutable patch. All fields optional (partial patch); `.strict()` so an unknown key is
// a 400 (a typo can't silently no-op). An empty body is rejected below — a PATCH must
// actually change something. roles is the ordered {id,label,description} list.
const WorkflowPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    promptScaffold: z.string().min(1).optional(),
    crossProject: z.boolean().optional(),
    roles: z
      .array(z.object({ id: z.string(), label: z.string(), description: z.string() }))
      .optional(),
  })
  .strict()

export async function workflowsRoutes(app: FastifyInstance) {
  // GET /api/workflows — all named workflow templates (seed order).
  app.get('/api/workflows', async (_req, reply) => {
    return reply.send(listWorkflowDefs())
  })

  // GET /api/workflows/:id — one template; 404 for an unknown id.
  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const def = getWorkflowDef(req.params.id)
    if (!def) return reply.status(404).send({ error: 'not found' })
    return reply.send(def)
  })

  // PATCH /api/workflows/:id — edit a template (name/scaffold/crossProject/roles). Validate
  // the patch (400), reject an empty body (400), then let updateWorkflowDef apply it. A null
  // return (unknown id) → 404. SEAM: `name` is UNIQUE, so renaming onto an existing name throws
  // a SQLITE_CONSTRAINT_UNIQUE — a client error (a bad rename via the exposed Rename form), so
  // it maps to 400 with the row UNCHANGED (the UPDATE threw before committing); any OTHER throw
  // re-throws so Fastify answers 500 instead of mislabelling it a 400.
  app.patch<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const parsed = WorkflowPatchSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'invalid patch' })
    if (Object.keys(parsed.data).length === 0) {
      return reply.status(400).send({ error: 'empty patch' })
    }
    try {
      const updated = updateWorkflowDef(req.params.id, parsed.data)
      if (!updated) return reply.status(404).send({ error: 'not found' })
      return reply.send(updated)
    } catch (e) {
      const msg = (e as Error).message
      if (/UNIQUE constraint/i.test(msg)) return reply.status(400).send({ error: 'name already in use' })
      throw e
    }
  })
}
