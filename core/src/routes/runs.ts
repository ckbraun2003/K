import type { FastifyInstance } from 'fastify'
import { StartRunBodySchema, RunsQuerySchema } from '@k/shared'
import { startRun, kill } from '../supervisor.js'
import { runsDb, eventsDb, projectsDb } from '../db.js'

export async function runsRoutes(app: FastifyInstance) {
  // POST /api/runs — start a new agent run
  app.post('/api/runs', async (req, reply) => {
    const parsed = StartRunBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { prompt, cwd, model, projectId } = parsed.data
    // TOCTOU note: if a project-delete route ever lands, a project could be
    // removed between this check and the FK INSERT in startRun, producing a 500.
    // That path is unreachable today (no delete route exists), so this is acceptable.
    if (projectId && !projectsDb.getProject.get(projectId)) {
      return reply.status(400).send({ error: 'unknown projectId' })
    }
    const run = await startRun(prompt, { cwd, model, projectId })
    return reply.status(201).send(run)
  })

  // GET /api/runs — list recent runs; optional ?status= and ?limit= query params
  app.get('/api/runs', async (req, reply) => {
    const parsed = RunsQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const rows = runsDb.listRunsFiltered(parsed.data)
    return reply.send(rows.map(dbRowToRun))
  })

  // GET /api/runs/:id — single run
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(dbRowToRun(row))
  })

  // GET /api/runs/:id/events — event log for a run
  // ?raw=1 opts into including the original JSON line in each event.
  // Only the literal '1' enables it; ?raw=true / bare ?raw are intentionally off.
  app.get<{ Params: { id: string }; Querystring: { raw?: string } }>('/api/runs/:id/events', async (req, reply) => {
    const rows = eventsDb.listEvents.all(req.params.id) as Array<Record<string, unknown>>
    const includeRaw = req.query.raw === '1'
    return reply.send(rows.map(r => dbRowToEvent(r, includeRaw)))
  })

  // GET /api/runs/:id/events/:seq/raw — lazy single-event raw fetch.
  // Returns { raw: string } for the one event identified by run_id + seq.
  // 404 if the event doesn't exist OR if it exists but has no stored raw (null).
  app.get<{ Params: { id: string; seq: string } }>('/api/runs/:id/events/:seq/raw', async (req, reply) => {
    const seq = Number(req.params.seq)
    const row = eventsDb.getEventRaw.get(req.params.id, seq) as { raw: string | null } | undefined
    if (!row || row.raw == null) return reply.status(404).send({ error: 'not found' })
    return reply.send({ raw: row.raw })
  })

  // POST /api/runs/:id/kill — kill a running agent
  app.post<{ Params: { id: string } }>('/api/runs/:id/kill', async (req, reply) => {
    const killed = kill(req.params.id)
    return reply.send({ killed })
  })
}

function dbRowToRun(r: Record<string, unknown>) {
  return {
    id: r.id, prompt: r.prompt, cwd: r.cwd, worktree: r.worktree,
    status: r.status, provider: r.provider, model: r.model,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    projectId: r.project_id ?? undefined,
    createdAt: r.created_at, endedAt: r.ended_at,
  }
}

function dbRowToEvent(r: Record<string, unknown>, includeRaw = false) {
  return {
    id: r.id, runId: r.run_id, seq: r.seq, type: r.type, ts: r.ts,
    text: r.text, tool: r.tool,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    ...(includeRaw && r.raw != null ? { raw: r.raw as string } : {}),
  }
}
