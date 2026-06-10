import type { FastifyInstance } from 'fastify'
import { StartRunBodySchema } from '@k/shared'
import { startRun, kill } from '../supervisor.js'
import { runsDb, eventsDb } from '../db.js'

export async function runsRoutes(app: FastifyInstance) {
  // POST /api/runs — start a new agent run
  app.post('/api/runs', async (req, reply) => {
    const parsed = StartRunBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { prompt, cwd, model } = parsed.data
    const run = await startRun(prompt, { cwd, model })
    return reply.status(201).send(run)
  })

  // GET /api/runs — list recent runs
  app.get('/api/runs', async (_req, reply) => {
    const rows = runsDb.listRuns.all() as Array<Record<string, unknown>>
    return reply.send(rows.map(dbRowToRun))
  })

  // GET /api/runs/:id — single run
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(dbRowToRun(row))
  })

  // GET /api/runs/:id/events — event log for a run
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req, reply) => {
    const rows = eventsDb.listEvents.all(req.params.id) as Array<Record<string, unknown>>
    return reply.send(rows.map(dbRowToEvent))
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
    createdAt: r.created_at, endedAt: r.ended_at,
  }
}

function dbRowToEvent(r: Record<string, unknown>) {
  return {
    id: r.id, runId: r.run_id, seq: r.seq, type: r.type, ts: r.ts,
    text: r.text, tool: r.tool,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
  }
}
