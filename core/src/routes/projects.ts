import type { FastifyInstance } from 'fastify'
import { validateRegistration, registerProject, listProjects, getProject, ClientError, type RegistrationBody } from '../projects.js'
import { getGithubStatus } from '../github.js'
import { onboardProject } from '../onboard.js'
import { runVerification } from '../verify.js'
import { startRun } from '../supervisor.js'
import { verificationDb, rowToReport } from '../db.js'

// Natural-language prompt that triggers the Layer-2 verify-project skill.
const DEEP_VERIFY_PROMPT =
  'Use the verify-project skill to audit this project: run the CI auditor, ' +
  'test-coverage scout, PR reviewer, and doc-freshness checker, and report ' +
  'findings. Apply safe fixes via PR only — never push to a default branch.'

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
    try {
      return reply.send(onboardProject(project))
    } catch (e) {
      // fs writes can throw (EACCES/ENOSPC/stale localPath); surface { error } like register
      req.log.error(e)
      return reply.status(500).send({ error: 'onboarding failed' })
    }
  })

  // POST /api/projects/:id/verify — deterministic single-shot verification.
  // Optional body { deep?: boolean }: when deep === true, ALSO dispatch the
  // Layer-2 verify-project skill as a supervised run (fire-and-forget). The
  // deterministic report is always authoritative and returned immediately.
  app.post<{ Params: { id: string }; Body: { deep?: boolean } | null | undefined }>(
    '/api/projects/:id/verify',
    async (req, reply) => {
      const project = getProject(req.params.id)
      if (!project) return reply.status(404).send({ error: 'not found' })

      // Light validation: deep is an optional boolean. A missing/empty body is
      // a plain deterministic verify; a malformed `deep` is rejected.
      const body = req.body ?? {}
      if (typeof body !== 'object' || (body.deep !== undefined && typeof body.deep !== 'boolean')) {
        return reply.status(400).send({ error: 'deep must be a boolean' })
      }

      let report
      try {
        report = runVerification(project)
      } catch (e) {
        // fs/git/db work can throw (stale localPath, EACCES, db error); surface { error }
        req.log.error(e)
        return reply.status(500).send({ error: 'verification failed' })
      }

      // Deep dispatch: kick off the agent run without awaiting. A dispatch
      // failure must NOT 500 the (already-successful) deterministic response.
      if (body.deep === true) {
        void startRun(DEEP_VERIFY_PROMPT, {
          cwd: project.localPath,
          projectId: project.id,
        }).catch((e) => req.log.error({ err: e }, 'deep verify dispatch failed'))
      }

      return reply.send(report)
    },
  )

  // GET /api/projects/:id/verifications — recent reports, newest first (SQL-ordered)
  app.get<{ Params: { id: string } }>('/api/projects/:id/verifications', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const rows = verificationDb.listVerificationReports.all(project.id) as Array<Record<string, unknown>>
    return reply.send(rows.map(rowToReport))
  })
}
