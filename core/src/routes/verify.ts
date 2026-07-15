import type { FastifyInstance } from 'fastify'
import { UpdateVerifyRecipeBodySchema } from '@k/shared'
import { runsDb, verifyResultsDb, projectsDb } from '../db.js'
import { getProject } from '../projects.js'
import { rowToVerifyResult, triggerVerify } from '../run-verify.js'
import { sendError, sendZodError } from './http-errors.js'

export async function verifyRoutes(app: FastifyInstance) {
  // GET /api/runs/:id/verify-result — the run's CURRENT verify result.
  // 404 unknown run · 200 { result: null } when never verified (BE-3c: the old 404
  // printed console noise on every recipe-less run) · 200 bare VerifyResult found.
  app.get<{ Params: { id: string } }>('/api/runs/:id/verify-result', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    const row = verifyResultsDb.getVerifyResult.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return reply.send({ result: null })
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

  // POST /api/runs/:id/verify — re-run the recipe battery (E-06: flip a red
  // k/verify status green after a fix). 202 fire-and-forget; readback via
  // GET /api/runs/:id/verify-result + the verify_update WS member.
  app.post<{ Params: { id: string } }>('/api/runs/:id/verify', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    if (row.status !== 'done') return sendError(reply, 409, 'run is not done')
    const project = row.project_id != null ? getProject(String(row.project_id)) : null
    if (!project?.verifyRecipe || project.pathMissing) return sendError(reply, 409, 'project has no verify recipe')
    if (!triggerVerify(req.params.id, project)) return sendError(reply, 409, 'verify already running')
    return reply.status(202).send({ started: true })
  })
}
