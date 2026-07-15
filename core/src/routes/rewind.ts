import type { FastifyInstance } from 'fastify'
import { execa } from 'execa'
import fs from 'fs'
import { RewindBodySchema, isKnownModel, type RunImpactPayload } from '@k/shared'
import { runsDb } from '../db.js'
import { listRunCheckpoints } from '../checkpoints.js'
import { startRun } from '../supervisor.js'
import { getProject } from '../projects.js'
import { isProjectIndexed, loadGraphJson, scopeForFiles, riskForScope } from '../gitnexus-scope.js'
import { budgetGate } from '../budget-governor.js'
import { sendError, sendZodError, sendBudgetCapped } from './http-errors.js'

const GIT_BOUND = { timeout: 30_000, killSignal: 'SIGKILL' as const }
const MAX_SYMBOLS_PER_FILE = 20 // panel cap — full counts still reported in totals

export async function rewindRoutes(app: FastifyInstance) {
  // GET /api/runs/:id/checkpoints — the run's chain, from its persisted events.
  app.get<{ Params: { id: string } }>('/api/runs/:id/checkpoints', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    return reply.send(listRunCheckpoints(req.params.id))
  })

  // POST /api/runs/:id/rewind — dispatch a NEW run whose worktree starts AT the
  // chosen checkpoint (never mutates the original run). Validation chain:
  // body 400 → run 404 → sha-not-in-chain 400 → cwd 409 → commit-gone 409.
  app.post<{ Params: { id: string } }>('/api/runs/:id/rewind', async (req, reply) => {
    const parsed = RewindBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (parsed.data.model !== undefined && !isKnownModel(parsed.data.model)) {
      return sendError(reply, 400, 'unknown model')
    }
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const sha = parsed.data.sha.toLowerCase()
    if (!listRunCheckpoints(req.params.id).some(c => c.sha.toLowerCase() === sha)) {
      return sendError(reply, 400, "sha is not one of this run's checkpoints")
    }
    const repoCwd = String(row.cwd)
    if (!fs.existsSync(repoCwd)) return sendError(reply, 409, 'run cwd no longer exists on disk')
    try {
      await execa('git', ['-C', repoCwd, 'cat-file', '-e', `${sha}^{commit}`], GIT_BOUND)
    } catch {
      return sendError(reply, 409, 'checkpoint commit no longer exists in the repo')
    }
    // P5-FU-1: a rewind dispatches a PAID run — same budget park as POST /api/runs.
    const g = budgetGate({ projectId: row.project_id != null ? String(row.project_id) : null })
    if (!g.allowed) return sendBudgetCapped(reply, g)
    try {
      const run = await startRun(parsed.data.prompt, {
        cwd: repoCwd,
        projectId: row.project_id != null ? String(row.project_id) : undefined,
        model: parsed.data.model,
        baseCommit: sha,
      })
      return reply.status(201).send(run)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'rewind dispatch failed')
    }
  })

  // GET /api/runs/:id/impact — E-07 blast radius over the run's changed files.
  // Degrades HONESTLY: no project / unindexed / no checkpoints / no graph →
  // an indexed:false-or-empty payload, never an error.
  app.get<{ Params: { id: string } }>('/api/runs/:id/impact', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const projectId = row.project_id != null ? String(row.project_id) : null
    const empty = (indexed: boolean): RunImpactPayload =>
      ({ indexed, projectId, files: [], totalSymbols: 0, totalDependents: 0, risk: null })
    const project = projectId ? getProject(projectId) : null
    if (!project || project.pathMissing || !isProjectIndexed(project.localPath)) {
      return reply.send(empty(false))
    }
    const ckpts = listRunCheckpoints(req.params.id)
    if (ckpts.length === 0) return reply.send(empty(true))
    let changed: string[]
    try {
      const baseSha = (await execa('git', ['-C', project.localPath, 'rev-parse', `${ckpts[0].sha}^`], GIT_BOUND)).stdout.trim()
      const head = ckpts[ckpts.length - 1].sha
      const names = (await execa('git', ['-C', project.localPath, 'diff', '--name-only', baseSha, head], GIT_BOUND)).stdout
      changed = names.split('\n').map(s => s.trim()).filter(Boolean)
    } catch {
      // A GC'd/pruned checkpoint commit (e.g. swept refs) is an ABSENCE, not an
      // error — honor the route's "never an error" degrade promise. (P1 SEAMS M2)
      return reply.send(empty(true))
    }
    try {
      const graph = loadGraphJson(project.localPath)
      if (!graph) return reply.send(empty(true))
      const scopes = scopeForFiles(graph, changed)
      const payload: RunImpactPayload = {
        indexed: true,
        projectId,
        files: scopes.map(f => ({ file: f.file, symbols: f.symbols.slice(0, MAX_SYMBOLS_PER_FILE) })),
        totalSymbols: scopes.reduce((s, f) => s + f.symbols.length, 0),
        totalDependents: scopes.reduce((s, f) => s + f.symbols.reduce((x, y) => x + y.dependents, 0), 0),
        risk: riskForScope(scopes),
      }
      return reply.send(payload)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'impact failed')
    }
  })
}
