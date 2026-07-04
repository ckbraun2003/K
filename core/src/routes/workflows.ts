import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getWorkflowDef, listWorkflowDefs, updateWorkflowDef } from '../workflow-defs.js'
import { workflowRunsDb } from '../db.js'
import { dbRowToWorkflowRun } from './runs.js'
import { sendError } from './http-errors.js'

/**
 * Named-workflow definitions route (P5.3b, D-047) — the list + detail + editor for the
 * operator-editable workflow TEMPLATES (workflow_definitions), plus the recent
 * workflow-RUNS list (C2 — the run-picker's identity source). The definitions are the
 * DB entity distinct from the @k/shared WorkflowDefinition diagram type. Every mutation
 * is delegated to workflow-defs.ts::updateWorkflowDef (read-merge-write). Mirrors
 * routes/orchestrators.ts: zod `.strict()` so an unknown key is a 400, empty patch is a
 * 400, unknown id is a 404.
 */

/** Cap on the recent workflow-runs list — the picker needs identity, not history. */
const WORKFLOW_RUNS_LIMIT = 100

// The mutable patch. All fields optional (partial patch); `.strict()` so an unknown key is
// a 400 (a typo can't silently no-op). An empty body is rejected below — a PATCH must
// actually change something. `roles` is DELIBERATELY excluded (F-015 / CLAIM-04-2): a
// workflow's delegation roles are READ-ONLY — the detail editor renders them but never
// edits them — so accepting `roles` here would let a PATCH silently corrupt the role
// definitions. With `.strict()`, a stray `roles` key is now a 400, never persisted.
const WorkflowPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    promptScaffold: z.string().min(1).optional(),
    crossProject: z.boolean().optional(),
  })
  .strict()

export async function workflowsRoutes(app: FastifyInstance) {
  // GET /api/workflows — all named workflow templates (seed order).
  app.get('/api/workflows', async (_req, reply) => {
    return reply.send(listWorkflowDefs())
  })

  // GET /api/workflows/runs — the most recent workflow_runs (bounded), mapped to the
  // shared WorkflowRun shape via runs.ts's mapper. Registered BEFORE '/api/workflows/:id'
  // for readability (Fastify's router prefers the static segment over the param
  // regardless, but keeping the static route first makes that visibly true).
  app.get('/api/workflows/runs', async (_req, reply) => {
    const rows = workflowRunsDb.listRecentWorkflowRuns.all(WORKFLOW_RUNS_LIMIT) as Array<Record<string, unknown>>
    return reply.send(rows.map(dbRowToWorkflowRun))
  })

  // GET /api/workflows/:id — one template; 404 for an unknown id.
  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const def = getWorkflowDef(req.params.id)
    if (!def) return sendError(reply, 404, 'not found')
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
    if (!parsed.success) return sendError(reply, 400, 'invalid patch')
    if (Object.keys(parsed.data).length === 0) {
      return sendError(reply, 400, 'empty patch')
    }
    try {
      const updated = updateWorkflowDef(req.params.id, parsed.data)
      if (!updated) return sendError(reply, 404, 'not found')
      return reply.send(updated)
    } catch (e) {
      const msg = (e as Error).message
      if (/UNIQUE constraint/i.test(msg)) return sendError(reply, 400, 'name already in use')
      throw e
    }
  })
}
