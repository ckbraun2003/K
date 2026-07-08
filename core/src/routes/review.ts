// core/src/routes/review.ts — E-01 Review Deck routes (Lane A: diff endpoints).
import type { FastifyInstance } from 'fastify'
import { execa } from 'execa'
import fs from 'fs'
import type { DiffPayload } from '@k/shared'
import { runsDb } from '../db.js'
import { listRunCheckpoints } from '../checkpoints.js'
import { parseUnifiedDiff } from '../diff-parse.js'
import { getProject } from '../projects.js'
import { sendError } from './http-errors.js'

const GIT_BOUND = { timeout: 60_000, killSignal: 'SIGKILL' as const }
const DIFF_MAX_BUFFER = 64 * 1024 * 1024

/**
 * A run's durable diff endpoints, derived from its k-checkpoint chain:
 *   base = first checkpoint's parent (the HEAD the run started from),
 *   head = last checkpoint sha. Null when the run made no checkpoints.
 * The chain lives in the shared .git of run.cwd — it survives worktree removal.
 */
export async function checkpointDiffRefs(runId: string, repoCwd: string): Promise<{ base: string; head: string } | null> {
  const ckpts = listRunCheckpoints(runId)
  if (ckpts.length === 0) return null
  const { stdout } = await execa('git', ['-C', repoCwd, 'rev-parse', `${ckpts[0].sha}^`], GIT_BOUND)
  return { base: stdout.trim(), head: ckpts[ckpts.length - 1].sha }
}

export async function reviewRoutes(app: FastifyInstance) {
  // GET /api/runs/:id/diff — checkpoint-chain diff (E-01). Mid-run it lags the
  // live tree by at most one wave; at terminal it IS the final state (W0
  // terminal snapshot). 404 unknown · 409 vanished cwd · 500 git failure.
  app.get<{ Params: { id: string } }>('/api/runs/:id/diff', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const repoCwd = String(row.cwd)
    if (!fs.existsSync(repoCwd)) return sendError(reply, 409, 'run cwd no longer exists on disk')
    try {
      const refs = await checkpointDiffRefs(req.params.id, repoCwd)
      if (!refs) {
        const empty: DiffPayload = { source: 'checkpoint', baseRef: null, headRef: null, files: [], truncated: false }
        return reply.send(empty)
      }
      const { stdout } = await execa(
        'git', ['-C', repoCwd, 'diff', '--no-color', '-M', refs.base, refs.head],
        { ...GIT_BOUND, maxBuffer: DIFF_MAX_BUFFER },
      )
      const { files, truncated } = parseUnifiedDiff(stdout)
      const payload: DiffPayload = { source: 'checkpoint', baseRef: refs.base, headRef: refs.head, files, truncated }
      return reply.send(payload)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'diff failed')
    }
  })

  // GET /api/projects/:id/prs/:number/diff — PR variant via `gh pr diff`,
  // normalized through the SAME parser (one DiffPayload for both mounts).
  app.get<{ Params: { id: string; number: string } }>('/api/projects/:id/prs/:number/diff', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return sendError(reply, 404, 'not found')
    if (!project.githubRemote) return sendError(reply, 400, 'project has no GitHub remote')
    const num = Number(req.params.number)
    if (!Number.isInteger(num) || num <= 0) return sendError(reply, 400, 'invalid PR number')
    try {
      const { stdout } = await execa(
        'gh', ['pr', 'diff', String(num), '--repo', project.githubRemote],
        { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: DIFF_MAX_BUFFER },
      )
      const { files, truncated } = parseUnifiedDiff(stdout)
      const payload: DiffPayload = { source: 'pr', baseRef: null, headRef: null, files, truncated }
      return reply.send(payload)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 502, 'gh pr diff failed') // offline/unauth gh degrades to 502, never a crash
    }
  })
}
