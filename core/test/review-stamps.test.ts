/**
 * P2 E-05/E-06 — review.ts reviewed_at stamps + approve-time k/verify publish.
 * request-changes and approve both stamp runs.reviewed_at (drop the inbox card);
 * approve additionally upserts the freshly-opened PR into github_cache and
 * publishes the current verify verdict onto the PR head through the ONE publish
 * path (publishVerifyStatusIfLinked). Seams: supervisor echo (request-changes),
 * github.js createPR-resolve + publishCommitStatus-spy, and execa git resolve
 * (approve). DB isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

// git branch/push in approve → resolve (no live git). createPR + publishCommitStatus
// are mocked at the github.js module level below, so execa here is ONLY the two git
// calls the approve route makes directly. mockExeca goes through vi.hoisted so it is
// initialized before the hoisted vi.mock factories run (the static buildApp import
// eagerly loads supervisor→execa, which would otherwise hit its TDZ).
const { mockExeca } = vi.hoisted(() => ({ mockExeca: vi.fn() }))
vi.mock('execa', () => ({ execa: mockExeca }))

// Echo supervisor so request-changes never spawns a real claude child (the
// review-comments.test.ts seam verbatim — factory references NO outer bindings).
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

// createPR resolves to a fixed PR; publishCommitStatus is a spy (no execa). The rest
// of github.js (getGithubStatus) stays REAL so the fresh-PR cache read/upsert path
// and the link gate run against a genuinely-seeded github_cache.
const { publishSpy, createPrSpy } = vi.hoisted(() => ({
  publishSpy: vi.fn(async () => {}),
  createPrSpy: vi.fn(async (remote: string, opts: { title: string }) => ({
    number: 123, url: `https://github.com/${remote}/pull/123`, title: opts.title, state: 'open',
  })),
}))
vi.mock('../src/github.js', async () => {
  const actual = await vi.importActual<typeof import('../src/github.js')>('../src/github.js')
  return { ...actual, createPR: createPrSpy, publishCommitStatus: publishSpy }
})

import { buildApp } from '../src/index.js'
import { runsDb, reviewCommentsDb, projectsDb, verifyResultsDb, eventsDb, db } from '../src/db.js'
import { getGithubStatus } from '../src/github.js'
import type { PrInfo } from '@k/shared'

const AUTH = { authorization: 'Bearer dev-token-change-me' }
const JSON_H = { ...AUTH, 'content-type': 'application/json' }
let app: Awaited<ReturnType<typeof buildApp>>
const projectIds: string[] = []

function seedCheckpoint(runId: string, seq: number, sha: string, wave: number): void {
  eventsDb.insertEvent.run({
    id: randomUUID(), runId, seq, type: 'checkpoint', ts: 9,
    raw: JSON.stringify({ sha, tree: `t${wave}`, ref: `refs/k-checkpoints/${runId}`, wave }),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
    toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null,
    childLabel: null, contextTokens: null,
  })
}

beforeAll(async () => {
  mockExeca.mockResolvedValue({ stdout: '', stderr: '' })
  app = await buildApp()
})
afterAll(async () => {
  for (const id of projectIds) {
    try { db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  await app.close()
})

describe('request-changes stamps reviewed_at (E-05)', () => {
  it('stamps runs.reviewed_at after bundling drafts into a fix run', async () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'original ask', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    reviewCommentsDb.insertReviewComment.run({ id: randomUUID(), runId: rid, file: 'a.ts', line: 1,
      side: 'new', body: 'fix the guard', status: 'draft', createdAt: Date.now() })
    expect((runsDb.getRun.get(rid) as { reviewed_at: number | null }).reviewed_at).toBeNull()

    const res = await app.inject({ method: 'POST', url: `/api/runs/${rid}/request-changes`, headers: JSON_H, payload: {} })
    expect(res.statusCode).toBe(201)
    expect((runsDb.getRun.get(rid) as { reviewed_at: number | null }).reviewed_at).toEqual(expect.any(Number))
  })
})

describe('approve stamps reviewed_at + caches the fresh PR + publishes (E-05/E-06)', () => {
  it('stamps, upserts the freshly-opened PR (headRefName === branch), and publishes the verify verdict', async () => {
    publishSpy.mockClear()
    createPrSpy.mockClear()
    const pid = randomUUID(); projectIds.push(pid)
    projectsDb.insertProjectWithDefaultBranch({
      id: pid, name: `rs-approve-${pid.slice(0, 8)}`, localPath: process.cwd(),
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    }, 'main')
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'ship the widget', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })
    seedCheckpoint(rid, 1, 'a'.repeat(40), 1)
    seedCheckpoint(rid, 2, 'f'.repeat(40), 2) // final checkpoint = PR head
    // A passing verify result → approve should publish state 'success' onto the head.
    verifyResultsDb.upsertVerifyResult.run({
      runId: rid, status: 'pass', reason: null,
      commands: JSON.stringify([{ label: 't', run: 'x', exitCode: 0, ok: true, durationMs: 5, outputTail: '' }]),
      scope: null, startedAt: 1_000, completedAt: 42_000,
    })

    const res = await app.inject({ method: 'POST', url: `/api/runs/${rid}/approve`, headers: JSON_H, payload: {} })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { branch: string; pr: { number: number } }
    const branch = `k-review/${rid.slice(0, 8)}`
    expect(body.branch).toBe(branch)
    expect(body.pr.number).toBe(123)

    // reviewed_at stamped
    expect((runsDb.getRun.get(rid) as { reviewed_at: number | null }).reviewed_at).toEqual(expect.any(Number))

    // fresh PR upserted into the cache with headRefName === branch, OPEN, checks none
    const cached = getGithubStatus(pid).prs as PrInfo[]
    const mine = cached.find(p => p.number === 123)
    expect(mine).toBeDefined()
    expect(mine).toMatchObject({ number: 123, state: 'OPEN', checks: 'none', headRefName: branch })

    // ONE publish path: the fire-and-forget publish lands on the FINAL checkpoint sha
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
    expect(publishSpy).toHaveBeenCalledWith('owner/repo', 'f'.repeat(40),
      { state: 'success', description: expect.stringContaining('verify commands passed') })
  })

  it('publishes nothing when there is no verify row (absent → honest unverified)', async () => {
    publishSpy.mockClear()
    const pid = randomUUID(); projectIds.push(pid)
    projectsDb.insertProjectWithDefaultBranch({
      id: pid, name: `rs-noverify-${pid.slice(0, 8)}`, localPath: process.cwd(),
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    }, 'main')
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'no verify', cwd: process.cwd(), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })
    seedCheckpoint(rid, 1, 'a'.repeat(40), 1)

    const res = await app.inject({ method: 'POST', url: `/api/runs/${rid}/approve`, headers: JSON_H, payload: {} })
    expect(res.statusCode).toBe(201)
    // still stamped, still cached, but nothing published (no verify row)
    expect((runsDb.getRun.get(rid) as { reviewed_at: number | null }).reviewed_at).toEqual(expect.any(Number))
    expect(getGithubStatus(pid).prs.some(p => p.number === 123)).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(publishSpy).not.toHaveBeenCalled()
  })
})
