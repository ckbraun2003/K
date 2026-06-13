import type { FastifyInstance } from 'fastify'
import { validateRegistration, registerProject, listProjects, getProject, ClientError, type RegistrationBody } from '../projects.js'
import { getGithubStatus } from '../github.js'
import { onboardProject } from '../onboard.js'

export async function projectsRoutes(app: FastifyInstance) {
  // GET /api/projects — fleet list
  app.get('/api/projects', async (_req, reply) => reply.send(listProjects()))

  // POST /api/projects — register (path) or clone (githubUrl)
  app.post<{ Body: RegistrationBody }>('/api/projects', async (req, reply) => {
    const v = validateRegistration(req.body ?? ({} as RegistrationBody))
    if (!v.ok) return reply.status(400).send({ error: v.error })
    try {
      const project = await registerProject(req.body)
      return reply.status(201).send(project)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof ClientError) return reply.status(400).send({ error: msg })
      if (msg.includes('UNIQUE constraint')) return reply.status(409).send({ error: `a project named ${req.body.name} already exists` })
      req.log.error(e)
      return reply.status(500).send({ error: 'registration failed' })
    }
  })

  // GET /api/projects/:id/github — cached PR + CI status
  app.get<{ Params: { id: string } }>('/api/projects/:id/github', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(getGithubStatus(project.id))
  })

  // POST /api/projects/:id/onboard — scaffold bible §3 invariants (bible + CI)
  app.post<{ Params: { id: string } }>('/api/projects/:id/onboard', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(onboardProject(project))
  })
}
