import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import path from 'path'
import { validateRegistration, registerProject, listProjects, getProject, ClientError, type RegistrationBody } from '../projects.js'
import { getGithubStatus, createPR, syncIssues } from '../github.js'
import { onboardProject } from '../onboard.js'
import { runVerification } from '../verify.js'
import { startRun } from '../supervisor.js'
import { dispatchTaskWorkflow, TaskNotFoundError } from '../workflows.js'
import { verificationDb, rowToReport, projectTasksDb } from '../db.js'
import { buildGraph, getGraphMeta, isGraphStale, enrichNodes } from '../graph.js'
import { CreatePrOptsSchema, GraphDispatchBodySchema, DispatchTasksBodySchema, type ProjectTask, type GithubStatus } from '@k/shared'

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

  // GET /api/projects/github — fleet-level cached PR + CI status, keyed by id.
  // Collapses the Home/Projects grid's per-card fan-out (one request per card)
  // into a single batch read so a cold fleet load doesn't fire N parallel
  // /github requests (Wave C6). Each entry is the same cheap cached SQLite read
  // as the per-id route. Registered before the `:id` route; Fastify's router
  // prioritizes the static `github` segment over the `:id` param regardless.
  app.get('/api/projects/github', async (_req, reply) => {
    const statuses: Record<string, GithubStatus> = {}
    for (const project of listProjects()) statuses[project.id] = getGithubStatus(project.id)
    return reply.send(statuses)
  })

  // GET /api/projects/:id/github — cached PR + CI status (single project; still
  // used by the workspace PRs/CI + Overview tabs, which load one project at a time)
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
    projectTasksDb.insertProjectTask.run({
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: null,
      issueNumber: null,
      issueUrl: null,
      issueState: null,
    })
    return reply.status(201).send(task)
  })

  // POST /api/projects/:id/tasks/sync — pull GitHub issues into project_tasks.
  // syncIssues never throws: gh absent/unauth/offline OR a project with no remote
  // all resolve to { synced: 0, degraded: true }, so "sync is always safe to call"
  // — a normal 200 (degraded) outcome, never 400/500. Only a missing project 404s.
  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks/sync', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const result = await syncIssues(project)
    return reply.send(result)
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

  // POST /api/projects/:id/tasks/dispatch — launch ONE supervised delegation run
  // over a batch of selected todos. The selected tasks flip to in_progress and a
  // workflow_run row tracks the run lifecycle (see workflows.ts). 202 because the
  // agent run is async (mirrors how skills /trigger returns 202).
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/tasks/dispatch', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const parsed = DispatchTasksBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    try {
      const { workflowRunId, runId } = await dispatchTaskWorkflow(project, parsed.data.taskIds)
      return reply.status(202).send({ workflowRunId, runId })
    } catch (e) {
      // A bad/foreign taskId is a client error → 400; anything else is a 500.
      if (e instanceof TaskNotFoundError) return reply.status(400).send({ error: 'task not found' })
      req.log.error(e)
      return reply.status(500).send({ error: 'dispatch failed' })
    }
  })

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

  // GET /api/projects/:id/graph — knowledge graph data (.gitnexus/graph.json) + build meta
  app.get<{ Params: { id: string } }>('/api/projects/:id/graph', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const meta = getGraphMeta(project.id)
    const graphPath = path.join(project.localPath, '.gitnexus', 'graph.json')
    try {
      const raw = await readFile(graphPath, 'utf8')
      const data = JSON.parse(raw) as {
        nodes?: Array<Record<string, unknown>>
        edges?: Array<Record<string, unknown>>
        links?: Array<Record<string, unknown>>
      }
      const baseNodes = (data.nodes ?? []).map(n => ({
        id: n.id ?? n.name,
        label: (n.label ?? n.name ?? n.id) as string,
        type: n.type as string | undefined,
        group: n.group as string | undefined,
        ...n,
      }))
      // Best-effort per-node enrichment from existing harness data (Wave 2).
      // Never throws — a node only gains facts we could derive.
      const nodes = enrichNodes(project, baseNodes)
      const links = (data.links ?? data.edges ?? []).map(e => ({
        source: (e.source ?? e.from) as string,
        target: (e.target ?? e.to) as string,
        type: e.type as string | undefined,
      }))
      const stale = await isGraphStale(project, meta)
      return reply.send({
        nodes, links, stale,
        status: meta.status, builtAt: meta.builtAt,
        nodeCount: meta.nodeCount, edgeCount: meta.edgeCount, error: meta.error,
      })
    } catch (err) {
      // A missing artifact (ENOENT) is the normal "never built" case; anything
      // else (corrupt JSON, permissions) is unexpected — surface it in the log so
      // a status:'ready' paired with empty nodes isn't silently misleading.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        req.log.warn(err, 'graph.json read/parse failed')
      }
      // No usable graph artifact → empty + stale, but still surface build meta
      // (e.g. status 'error' from a failed build, or 'building' mid-flight).
      return reply.send({
        nodes: [], links: [], stale: true,
        status: meta.status, builtAt: meta.builtAt,
        nodeCount: meta.nodeCount, edgeCount: meta.edgeCount, error: meta.error,
      })
    }
  })

  // POST /api/projects/:id/graph/build — (re)build the graph via `npx gitnexus analyze`.
  // Fire-and-forget: returns 202 with the current (building) meta; completion and
  // failure are reported live over the WS graph_update channel.
  app.post<{ Params: { id: string } }>('/api/projects/:id/graph/build', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    void buildGraph(project).catch(err => req.log.error(err, 'graph build failed'))
    return reply.status(202).send(getGraphMeta(project.id))
  })

  // POST /api/projects/:id/graph/dispatch — launch a node-scoped agent run.
  // Builds a prompt from { nodeId, file?, action? } and creates a supervised run
  // in the project's repo via the existing startRun seam. 201 with the run.
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/graph/dispatch', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const parsed = GraphDispatchBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    const prompt = buildDispatchPrompt(parsed.data)
    try {
      const run = await startRun(prompt, { cwd: project.localPath, projectId: project.id })
      return reply.status(201).send(run)
    } catch (e) {
      req.log.error(e)
      return reply.status(500).send({ error: e instanceof Error ? e.message : 'dispatch failed' })
    }
  })
}

/** Build a node-scoped agent prompt from a validated dispatch body. The `action`
 *  selects the intent; `file` (preferred) or `nodeId` names the target. Pure. */
function buildDispatchPrompt(body: { nodeId: string; file?: string; action?: 'investigate' | 'fix' | 'explain' }): string {
  const target = body.file?.trim() || body.nodeId
  switch (body.action) {
    case 'fix':
      return `Investigate and fix failing tests or bugs in ${target}. Run the tests, find the root cause, and apply a minimal fix.`
    case 'explain':
      return `Explain the ${target} subsystem: its responsibilities, key functions, and how it connects to the rest of the codebase.`
    case 'investigate':
    default:
      return `Investigate ${target}: review the code, summarize what it does, and flag any issues or risks you find.`
  }
}

function rowToTask(r: Record<string, unknown>) {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    issueNumber: r.issue_number ?? null,
    issueUrl: r.issue_url ?? null,
    issueState: r.issue_state ?? null,
  }
}
