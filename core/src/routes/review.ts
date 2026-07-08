// core/src/routes/review.ts — E-01 Review Deck routes (Lane A: diff endpoints + comments).
import type { FastifyInstance } from 'fastify'
import { execa } from 'execa'
import fs from 'fs'
import { v4 as uuid } from 'uuid'
import type { DiffPayload } from '@k/shared'
import { CreateReviewCommentBodySchema, UpdateReviewCommentBodySchema, RequestChangesBodySchema, ApproveRunBodySchema, isKnownModel, type ReviewComment } from '@k/shared'
import { runsDb, reviewCommentsDb } from '../db.js'
import { listRunCheckpoints } from '../checkpoints.js'
import { parseUnifiedDiff } from '../diff-parse.js'
import { getProject } from '../projects.js'
import { startRun } from '../supervisor.js'
import { createPR } from '../github.js'
import { sendError, sendZodError } from './http-errors.js'

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

/** review_comments row → wire shape (snake→camel; nullable line). */
export function rowToReviewComment(r: Record<string, unknown>): ReviewComment {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    file: String(r.file),
    line: r.line == null ? null : Number(r.line),
    side: r.side as ReviewComment['side'],
    body: String(r.body),
    status: r.status as ReviewComment['status'],
    createdAt: Number(r.created_at),
  }
}

/**
 * Bundle review comments into the fix-run prompt (pure). The fix run's worktree
 * is created AT the reviewed run's final checkpoint (baseCommit), so the prompt
 * states the tree already holds the reviewed work — the agent fixes, not redoes.
 */
export function buildFixPrompt(originalPrompt: string, comments: ReviewComment[]): string {
  const head = originalPrompt.length > 2000 ? originalPrompt.slice(0, 2000) + '…' : originalPrompt
  const list = comments
    .map((c, i) => `${i + 1}. [${c.file}${c.line != null ? `:${c.line}` : ''}] ${c.body}`)
    .join('\n')
  return [
    'You are continuing a reviewed agent run. The working tree already contains the reviewed state of the work.',
    `Original task:\n${head}`,
    'The operator reviewed the changes and requests fixes. Address EVERY comment below, then re-run the relevant checks:',
    list,
    'Do not start unrelated work. Keep the existing changes unless a comment says otherwise.',
  ].join('\n\n')
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

  // GET /api/runs/:id/comments
  app.get<{ Params: { id: string } }>('/api/runs/:id/comments', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    const rows = reviewCommentsDb.listReviewComments.all(req.params.id) as Array<Record<string, unknown>>
    return reply.send(rows.map(rowToReviewComment))
  })

  // POST /api/runs/:id/comments — body 400 BEFORE existence 404 (F-022 ordering).
  app.post<{ Params: { id: string } }>('/api/runs/:id/comments', async (req, reply) => {
    const parsed = CreateReviewCommentBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    const comment: ReviewComment = {
      id: uuid(), runId: req.params.id,
      file: parsed.data.file, line: parsed.data.line ?? null, side: parsed.data.side,
      body: parsed.data.body, status: 'draft', createdAt: Date.now(),
    }
    reviewCommentsDb.insertReviewComment.run({
      id: comment.id, runId: comment.runId, file: comment.file, line: comment.line,
      side: comment.side, body: comment.body, status: comment.status, createdAt: comment.createdAt,
    })
    return reply.status(201).send(comment)
  })

  // PATCH /api/runs/:id/comments/:commentId — partial {body?, status?}.
  app.patch<{ Params: { id: string; commentId: string } }>('/api/runs/:id/comments/:commentId', async (req, reply) => {
    const parsed = UpdateReviewCommentBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const row = reviewCommentsDb.getReviewComment.get(req.params.commentId, req.params.id) as
      | Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const current = rowToReviewComment(row)
    const next = { ...current, body: parsed.data.body ?? current.body, status: parsed.data.status ?? current.status }
    reviewCommentsDb.updateReviewComment.run({ id: next.id, body: next.body, status: next.status })
    return reply.send(next)
  })

  // DELETE /api/runs/:id/comments/:commentId
  app.delete<{ Params: { id: string; commentId: string } }>('/api/runs/:id/comments/:commentId', async (req, reply) => {
    const res = reviewCommentsDb.deleteReviewComment.run(req.params.commentId, req.params.id)
    if (res.changes === 0) return sendError(reply, 404, 'not found')
    return reply.status(204).send()
  })

  // POST /api/runs/:id/request-changes — bundle DRAFT comments into a fix run
  // that STARTS FROM the reviewed final state (baseCommit = last checkpoint).
  // A run with no checkpoints degrades to a clean-HEAD fix run (comments still
  // bundled) — honest, and the prompt still lists every requested fix.
  app.post<{ Params: { id: string } }>('/api/runs/:id/request-changes', async (req, reply) => {
    const parsed = RequestChangesBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (parsed.data.model !== undefined && !isKnownModel(parsed.data.model)) {
      return sendError(reply, 400, 'unknown model')
    }
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const drafts = (reviewCommentsDb.listReviewComments.all(req.params.id) as Array<Record<string, unknown>>)
      .map(rowToReviewComment)
      .filter(c => c.status === 'draft')
    if (drafts.length === 0) return sendError(reply, 409, 'no draft comments to send')
    const ckpts = listRunCheckpoints(req.params.id)
    const baseCommit = ckpts.length > 0 ? ckpts[ckpts.length - 1].sha : undefined
    try {
      const run = await startRun(buildFixPrompt(String(row.prompt), drafts), {
        cwd: String(row.cwd),
        projectId: row.project_id != null ? String(row.project_id) : undefined,
        model: parsed.data.model,
        baseCommit,
      })
      // Flip ONLY the comments actually bundled into the prompt (quality-review
      // HIGH), via a status-only + still-draft-guarded statement (integration
      // review): a comment POSTed while startRun awaited must not be swept up,
      // and one PATCHed mid-await must keep its edit (no body-snapshot replay).
      for (const c of drafts) {
        reviewCommentsDb.markReviewCommentSent.run(c.id)
      }
      return reply.status(201).send({ run, commentsSent: drafts.length })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'fix-run dispatch failed')
    }
  })

  // POST /api/runs/:id/approve — publish the reviewed final state as a branch
  // and open a PR through the EXISTING createPR path. Branch name is derived
  // (k-review/<runId8>); base defaults to the project's detected default branch.
  app.post<{ Params: { id: string } }>('/api/runs/:id/approve', async (req, reply) => {
    const parsed = ApproveRunBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    const project = row.project_id != null ? getProject(String(row.project_id)) : null
    if (!project?.githubRemote) return sendError(reply, 400, 'run has no project with a GitHub remote')
    const repoCwd = String(row.cwd)
    if (!fs.existsSync(repoCwd)) return sendError(reply, 409, 'run cwd no longer exists on disk')
    const ckpts = listRunCheckpoints(req.params.id)
    if (ckpts.length === 0) return sendError(reply, 409, 'run has no checkpointed changes to approve')
    const head = ckpts[ckpts.length - 1].sha
    const branch = `k-review/${req.params.id.slice(0, 8)}`
    // Two catch scopes (quality-review HIGH): raw git/execa failure text can echo
    // the remote URL (credentials-in-remote setups), so it degrades to a fixed
    // message; createPR errors are already URL-sanitized at source (github.ts).
    try {
      await execa('git', ['-C', repoCwd, 'branch', '-f', branch, head], GIT_BOUND)
      await execa('git', ['-C', repoCwd, 'push', '-u', 'origin', branch], { timeout: 120_000, killSignal: 'SIGKILL' })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'branch publish failed')
    }
    const firstLine = String(row.prompt).split('\n')[0].slice(0, 255) || `K run ${req.params.id.slice(0, 8)}`
    try {
      const pr = await createPR(project.githubRemote, {
        title: parsed.data.title ?? firstLine,
        body: parsed.data.body ?? `Approved via K Review Deck (run ${req.params.id}).`,
        head: branch,
        base: parsed.data.base ?? project.defaultBranch ?? 'main',
      })
      return reply.status(201).send({ branch, pr })
    } catch (e) {
      // The pushed k-review/* branch stays on origin if createPR fails — safe:
      // re-approving is idempotent (branch -f + push no-op, createPR retried).
      req.log.error(e)
      return sendError(reply, 500, e instanceof Error ? e.message : 'approve failed')
    }
  })
}
