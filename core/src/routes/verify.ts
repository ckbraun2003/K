import type { FastifyInstance } from 'fastify'
import { UpdateVerifyRecipeBodySchema } from '@k/shared'
import { runsDb, verifyResultsDb, projectsDb } from '../db.js'
import { getProject } from '../projects.js'
import { rowToVerifyResult } from '../run-verify.js'
import { sendError, sendZodError } from './http-errors.js'

export async function verifyRoutes(app: FastifyInstance) {
  // GET /api/runs/:id/verify-result — the run's CURRENT verify result.
  // 404 unknown run · 404 'no verify result' (recipe-less/never verified).
  app.get<{ Params: { id: string } }>('/api/runs/:id/verify-result', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    const row = verifyResultsDb.getVerifyResult.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'no verify result')
    return reply.send(rowToVerifyResult(row))
  })

  // PATCH /api/projects/:id/verify-recipe — set (validated) or clear (null).
  // Body 400 BEFORE existence 404 (F-022). Returns the updated Project.
  app.patch<{ Params: { id: string } }>('/api/projects/:id/verify-recipe', async (req, reply) => {
    const parsed = UpdateVerifyRecipeBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const project = getProject(req.params.id)
    if (!project) return sendError(reply, 404, 'not found')
    projectsDb.setProjectVerifyRecipe.run(
      parsed.data.recipe === null ? null : JSON.stringify(parsed.data.recipe),
      project.id,
    )
    return reply.send(getProject(project.id))
  })
}
