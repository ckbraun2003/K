/**
 * P1 A1 — GET /api/runs/:id/diff derives the DURABLE diff from the checkpoint
 * chain: base = first checkpoint's parent, head = last checkpoint. Also locks
 * the no-checkpoints empty payload + the 404/409 guards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { randomUUID } from 'node:crypto'
// index.js runs its full bootstrap (listen + pollers) at IMPORT time unless
// K_SKIP_BOOTSTRAP=1. A static top-level import would fire that before beforeAll
// could set the env, so — mirroring app-routes.test.ts — buildApp is imported
// DYNAMICALLY inside beforeAll after the env is set. The type below uses a
// type-only `import(...)` which is erased at runtime (no bootstrap).
import { runsDb, eventsDb, projectsDb } from '../src/db.js'
import { createCheckpoint, type CheckpointInfo } from '../src/checkpoints.js'

const AUTH = { authorization: 'Bearer dev-token-change-me' }
let app: Awaited<ReturnType<typeof import('../src/index.js').buildApp>>
let base: string
let repo: string
let runId: string

function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }

function insertCkptEvent(rid: string, seq: number, info: CheckpointInfo): void {
  eventsDb.insertEvent.run({
    id: randomUUID(), runId: rid, seq, type: 'checkpoint', ts: Date.now(),
    raw: JSON.stringify({ sha: info.sha, tree: info.tree, ref: info.ref, wave: info.wave }),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null,
    toolUseId: null, toolKind: null, toolInput: null, toolResult: null,
    toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null,
  })
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-diffrt-'))
  repo = path.join(base, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@k']); git(repo, ['config', 'user.name', 'K'])
  git(repo, ['config', 'commit.gpgsign', 'false']); git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init'])
  const wt = path.join(base, 'wt')
  git(repo, ['worktree', 'add', '--detach', wt])

  runId = randomUUID()
  runsDb.insertRun.run({ id: runId, prompt: 'x', cwd: repo, worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n')
  const w1 = (await createCheckpoint(wt, runId, 1, null))!
  insertCkptEvent(runId, 3, w1)
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new file\n')
  const w2 = (await createCheckpoint(wt, runId, 2, w1))!
  insertCkptEvent(runId, 7, w2)
  git(repo, ['worktree', 'remove', '--force', wt]) // terminal state: worktree GONE, refs live
}, 30_000) // app build + git fixture + 2 checkpoints sits at the 10s default on slow disks
afterAll(async () => {
  await app.close()
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* */ }
})

describe('GET /api/runs/:id/diff', () => {
  it('derives the full diff across the chain with the worktree gone', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.source).toBe('checkpoint')
    expect(body.baseRef).toBe(git(repo, ['rev-parse', 'HEAD']).trim())
    const paths = body.files.map((f: { path: string }) => f.path).sort()
    expect(paths).toEqual(['a.txt', 'b.txt'])
    const added = body.files.find((f: { path: string }) => f.path === 'b.txt')
    expect(added.status).toBe('added')
  })

  it('a run with no checkpoints → empty payload, not an error', async () => {
    const bare = randomUUID()
    runsDb.insertRun.run({ id: bare, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${bare}/diff`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ source: 'checkpoint', baseRef: null, headRef: null, files: [], truncated: false })
  })

  it('404 unknown run; 409 vanished cwd', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/diff`, headers: AUTH })).statusCode).toBe(404)
    const ghost = randomUUID()
    runsDb.insertRun.run({ id: ghost, prompt: 'x', cwd: path.join(base, 'gone'), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    expect((await app.inject({ method: 'GET', url: `/api/runs/${ghost}/diff`, headers: AUTH })).statusCode).toBe(409)
  })
})

// Quality-review addition: the PR-diff endpoint's gh-free guard paths (the gh
// success/502 legs are exercised live by the smoke — no gh spawn in unit tests).
describe('GET /api/projects/:id/prs/:number/diff guards', () => {
  it('404 unknown project; 400 no GitHub remote; 400 invalid PR number', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/projects/${randomUUID()}/prs/1/diff`, headers: AUTH })).statusCode).toBe(404)

    const noRemote = randomUUID()
    projectsDb.insertProjectWithDefaultBranch({
      id: noRemote, name: `p1a-nr-${noRemote.slice(0, 8)}`, localPath: repo,
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    }, 'main')
    expect((await app.inject({ method: 'GET', url: `/api/projects/${noRemote}/prs/1/diff`, headers: AUTH })).statusCode).toBe(400)

    const withRemote = randomUUID()
    projectsDb.insertProjectWithDefaultBranch({
      id: withRemote, name: `p1a-wr-${withRemote.slice(0, 8)}`, localPath: repo,
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    }, 'main')
    expect((await app.inject({ method: 'GET', url: `/api/projects/${withRemote}/prs/abc/diff`, headers: AUTH })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/projects/${withRemote}/prs/-3/diff`, headers: AUTH })).statusCode).toBe(400)
  })
})
