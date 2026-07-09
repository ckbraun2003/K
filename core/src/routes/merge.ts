import type { FastifyInstance } from 'fastify'
import { SetAutoMergeBodySchema } from '@k/shared'
import { projectsDb } from '../db.js'
import { getProject } from '../projects.js'
import { fetchPrMergeReadiness, mergePr } from '../github.js'
import { sendError, sendZodError } from './http-errors.js'

/** E-06 one-click merge + auto-merge routes. */
export async function mergeRoutes(app: FastifyInstance) {
  // POST /api/projects/:id/prs/:number/merge — merge ONLY on a green readback.
  app.post<{ Params: { id: string; number: string } }>('/api/projects/:id/prs/:number/merge', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return sendError(reply, 404, 'not found')
    if (!project.githubRemote) return sendError(reply, 400, 'project has no GitHub remote')
    const number = Number(req.params.number)
    if (!Number.isInteger(number) || number <= 0) return sendError(reply, 400, 'bad PR number')
    try {
      const ready = await fetchPrMergeReadiness(project.githubRemote, number, project.localPath)
      if (String(ready.state).toUpperCase() !== 'OPEN') return sendError(reply, 409, 'PR is not open')
      if (ready.checks !== 'passing') return sendError(reply, 409, `checks are ${ready.checks} — merge blocked`)
      await mergePr(project.githubRemote, number)
      return reply.send({ merged: true, number })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 502, e instanceof Error ? e.message : 'merge failed')
    }
  })

  // PATCH /api/projects/:id/auto-merge — default OFF; explicit opt-in only.
  app.patch<{ Params: { id: string } }>('/api/projects/:id/auto-merge', async (req, reply) => {
    const parsed = SetAutoMergeBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (!getProject(req.params.id)) return sendError(reply, 404, 'not found')
    projectsDb.setProjectAutoMerge.run(parsed.data.enabled ? 1 : 0, req.params.id)
    return reply.send(getProject(req.params.id))
  })
}
