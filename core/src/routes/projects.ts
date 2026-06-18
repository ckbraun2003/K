import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import path from 'path'
import { validateRegistration, registerProject, listProjects, getProject, ClientError, type RegistrationBody } from '../projects.js'
import { getGithubStatus, createPR } from '../github.js'
import { onboardProject } from '../onboard.js'
import { runVerification } from '../verify.js'
import { startRun } from '../supervisor.js'
import { verificationDb, rowToReport, projectTasksDb } from '../db.js'
import { CreatePrOptsSchema, type ProjectTask } from '@k/shared'

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
      // Reject non-objects (incl. JSON arrays — typeof [] === 'object') and a
      // non-boolean `deep`; a missing/empty object body is a plain verify.
      if (typeof body !== 'object' || Array.isArray(body) || (body.deep !== undefined && typeof body.deep !== 'boolean')) {
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

  // GET /api/projects/:id/tasks — list tasks for project
  app.get<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const rows = projectTasksDb.listProjectTasks.all(project.id) as Array<Record<string, unknown>>
    return reply.send(rows.map(rowToTask))
  })

  // POST /api/projects/:id/tasks — create a task
  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/projects/:id/tasks', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title || title.length > 1000) return reply.status(400).send({ error: 'title must be 1–1000 characters' })
    const task: ProjectTask = {
      id: randomUUID(),
      projectId: project.id,
      title,
      status: 'open',
      createdAt: Date.now(),
      completedAt: null,
    }
    projectTasksDb.insertProjectTask.run({ id: task.id, projectId: task.projectId, title: task.title, status: task.status, createdAt: task.createdAt })
    return reply.status(201).send(task)
  })

  // PATCH /api/projects/:id/tasks/:taskId — update task status
  app.patch<{ Params: { id: string; taskId: string }; Body: { status?: string } }>(
    '/api/projects/:id/tasks/:taskId',
    async (req, reply) => {
      const project = getProject(req.params.id)
      if (!project) return reply.status(404).send({ error: 'not found' })
      const VALID_STATUSES = ['open', 'in_progress', 'done'] as const
      type TaskStatus = typeof VALID_STATUSES[number]
      const status = req.body?.status
      if (!status || !VALID_STATUSES.includes(status as TaskStatus)) {
        return reply.status(400).send({ error: 'status must be one of: open, in_progress, done' })
      }
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!UUID_RE.test(req.params.taskId)) return reply.status(400).send({ error: 'invalid taskId' })
      const row = projectTasksDb.getProjectTask.get(req.params.taskId, project.id) as Record<string, unknown> | undefined
      if (!row) return reply.status(404).send({ error: 'task not found' })
      const completedAt = status === 'done' ? Date.now() : null
      projectTasksDb.updateProjectTaskStatus.run({
        id: req.params.taskId,
        projectId: project.id,
        status,
        completedAt,
      })
      return reply.send(rowToTask({ ...row, status, completed_at: completedAt }))
    }
  )

  // POST /api/projects/:id/prs — create a GitHub PR via gh CLI
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/prs', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    if (!project.githubRemote) return reply.status(400).send({ error: 'project has no GitHub remote' })
    const parsed = CreatePrOptsSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    try {
      const pr = await createPR(project.githubRemote, parsed.data)
      return reply.status(201).send(pr)
    } catch (e) {
      req.log.error(e)
      return reply.status(500).send({ error: e instanceof Error ? e.message : 'gh pr create failed' })
    }
  })

  // GET /api/projects/:id/graph — knowledge graph data from .gitnexus/graph.json
  app.get<{ Params: { id: string } }>('/api/projects/:id/graph', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const graphPath = path.join(project.localPath, '.gitnexus', 'graph.json')
    try {
      const raw = await readFile(graphPath, 'utf8')
      const data = JSON.parse(raw) as {
        nodes?: Array<Record<string, unknown>>
        edges?: Array<Record<string, unknown>>
        links?: Array<Record<string, unknown>>
      }
      const nodes = (data.nodes ?? []).map(n => ({
        id: n.id ?? n.name,
        label: (n.label ?? n.name ?? n.id) as string,
        type: n.type as string | undefined,
        group: n.group as string | undefined,
        ...n,
      }))
      const links = (data.links ?? data.edges ?? []).map(e => ({
        source: (e.source ?? e.from) as string,
        target: (e.target ?? e.to) as string,
        type: e.type as string | undefined,
      }))
      return reply.send({ nodes, links, stale: false })
    } catch {
      return reply.send({ nodes: [], links: [], stale: true })
    }
  })
}

function rowToTask(r: Record<string, unknown>) {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
  }
}
