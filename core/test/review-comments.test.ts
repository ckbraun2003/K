/**
 * P1 A2 — review comments CRUD + request-changes flow. The fix-run dispatch
 * itself is exercised live (smoke); here we lock validation ordering (F-022:
 * body 400 before existence 404), the draft→sent flip, and buildFixPrompt.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

// index.js fires its listen()/poller bootstrap at IMPORT time unless K_SKIP_BOOTSTRAP=1.
// This file statically imports buildApp (below), so set the flag in a vi.hoisted() block —
// hoisted ABOVE all imports — so it is set before index.js is evaluated. (app-routes.test.ts
// uses a dynamic import in beforeAll for the same reason; the static import here needs this.)
vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

// Mock the supervisor so the 201 request-changes path never spawns a real claude
// child or creates a worktree under the REAL repo (run rows here use process.cwd()) —
// the app-routes.test.ts precedent. The fake ECHOES prompt + opts so the route's
// contract (prompt bundle, cwd, baseCommit passthrough) stays assertable. NOTE: the
// factory is hoisted — reference NO outer bindings inside it.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  let n = 0
  return {
    ...actual,
    startRun: vi.fn(async (prompt: string, opts: { cwd: string; projectId?: string; model?: string; baseCommit?: string }) => ({
      id: `mock-fix-${++n}`, prompt, cwd: opts.cwd, worktree: undefined, status: 'queued',
      provider: 'claude', model: opts.model ?? 'mock', tokensIn: 0, tokensOut: 0,
      costUsd: 0, projectId: opts.projectId, createdAt: Date.now(),
    })),
  }
})

import { buildApp } from '../src/index.js'
import { runsDb, reviewCommentsDb, projectsDb } from '../src/db.js'
import { startRun } from '../src/supervisor.js'
import { buildFixPrompt } from '../src/routes/review.js'
import type { ReviewComment } from '@k/shared'

const AUTH = { authorization: 'Bearer dev-token-change-me' }
const JSON_H = { ...AUTH, 'content-type': 'application/json' }
let app: Awaited<ReturnType<typeof buildApp>>
let runId: string

beforeAll(async () => {
  app = await buildApp()
  runId = randomUUID()
  runsDb.insertRun.run({ id: runId, prompt: 'build the widget', cwd: process.cwd(), worktree: null,
    status: 'done', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: null, createdAt: Date.now() })
})
afterAll(async () => { await app.close() })

describe('review comments CRUD', () => {
  it('POST → GET → PATCH → DELETE round-trip', async () => {
    const post = await app.inject({ method: 'POST', url: `/api/runs/${runId}/comments`, headers: JSON_H,
      payload: { file: 'src/a.ts', line: 3, body: 'rename this' } })
    expect(post.statusCode).toBe(201)
    const c = post.json()
    expect(c).toMatchObject({ runId, file: 'src/a.ts', line: 3, side: 'new', status: 'draft' })

    const list = await app.inject({ method: 'GET', url: `/api/runs/${runId}/comments`, headers: AUTH })
    expect(list.json()).toHaveLength(1)

    const patch = await app.inject({ method: 'PATCH', url: `/api/runs/${runId}/comments/${c.id}`, headers: JSON_H,
      payload: { status: 'resolved' } })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().status).toBe('resolved')

    const del = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}/comments/${c.id}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}/comments`, headers: AUTH })).json()).toHaveLength(0)
  })

  it('validation order: bad body → 400 even for an unknown run; then 404', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/runs/${randomUUID()}/comments`, headers: JSON_H,
      payload: { file: '', body: '' } })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({ method: 'POST', url: `/api/runs/${randomUUID()}/comments`, headers: JSON_H,
      payload: { file: 'a.ts', body: 'x' } })
    expect(missing.statusCode).toBe(404)
  })
})

describe('request-changes', () => {
  it('409 with no draft comments; unknown model 400', async () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'p', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    expect((await app.inject({ method: 'POST', url: `/api/runs/${rid}/request-changes`, headers: JSON_H, payload: {} })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${rid}/request-changes`, headers: JSON_H,
      payload: { model: 'not-a-model' } })).statusCode).toBe(400)
  })

  it('dispatches a fix run and flips drafts to sent (201)', async () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'original ask', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    reviewCommentsDb.insertReviewComment.run({ id: randomUUID(), runId: rid, file: 'a.ts', line: 1,
      side: 'new', body: 'fix the guard', status: 'draft', createdAt: Date.now() })
    vi.mocked(startRun).mockClear()
    const res = await app.inject({ method: 'POST', url: `/api/runs/${rid}/request-changes`, headers: JSON_H, payload: {} })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.commentsSent).toBe(1)
    expect(body.run.prompt).toContain('fix the guard')
    expect(body.run.prompt).toContain('original ask')
    // The route passed the original run's cwd and NO baseCommit (no checkpoints →
    // the documented clean-HEAD degrade). The real dispatch leg is the smoke's.
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const [, opts] = vi.mocked(startRun).mock.calls[0]
    expect(opts).toMatchObject({ cwd: process.cwd() })
    expect(opts.baseCommit).toBeUndefined()
    const after = reviewCommentsDb.listReviewComments.all(rid) as Array<{ status: string }>
    expect(after[0].status).toBe('sent')
  })
})

describe('approve guards', () => {
  it('404 unknown; 400 for a run with no project remote; 409 with no checkpoints', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/runs/${randomUUID()}/approve`, headers: JSON_H, payload: {} })).statusCode).toBe(404)
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'p', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    expect((await app.inject({ method: 'POST', url: `/api/runs/${rid}/approve`, headers: JSON_H, payload: {} })).statusCode).toBe(400)

    // 409 leg (quality-review gap): remote-bearing project + existing cwd but no
    // checkpoints — the guard fires BEFORE any git/gh call, so no process spawns.
    const pid = randomUUID()
    projectsDb.insertProjectWithDefaultBranch({
      id: pid, name: `p1a2-ap-${pid.slice(0, 8)}`, localPath: process.cwd(),
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    }, 'main')
    const rid2 = randomUUID()
    runsDb.insertRun.run({ id: rid2, prompt: 'p', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })
    expect((await app.inject({ method: 'POST', url: `/api/runs/${rid2}/approve`, headers: JSON_H, payload: {} })).statusCode).toBe(409)
  })
})

describe('buildFixPrompt', () => {
  it('numbers comments with file:line anchors and embeds the original ask', () => {
    const comments: ReviewComment[] = [
      { id: '1', runId: 'r', file: 'src/a.ts', line: 3, side: 'new', body: 'rename x', status: 'draft', createdAt: 1 },
      { id: '2', runId: 'r', file: 'src/b.ts', line: null, side: 'new', body: 'add a test', status: 'draft', createdAt: 2 },
    ]
    const p = buildFixPrompt('do the thing', comments)
    expect(p).toContain('1. [src/a.ts:3] rename x')
    expect(p).toContain('2. [src/b.ts] add a test')
    expect(p).toContain('do the thing')
    expect(p).toContain('already contains the reviewed state')
  })
})
