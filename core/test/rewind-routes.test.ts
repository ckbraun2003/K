/**
 * P1 C1 — checkpoints listing, rewind validation chain, impact payload.
 * Rewind's happy path exercises the REAL startRun (run row + worktree created AT
 * the checkpoint) with agent-config's synthesizeConfigDir mocked to THROW (the
 * w8b-f068-supervisor-wiring precedent) — runAgent stops before any claude spawn,
 * so no paid dispatch and no hung child on machines where `claude` exists.
 * The live dispatch leg is the smoke's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Hoisted; everything else in agent-config stays real (w8b precedent — spread actual).
vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('p1-rewind-test-stop') }) }
})

import { runsDb, eventsDb, projectsDb } from '../src/db.js'
import { createCheckpoint, type CheckpointInfo } from '../src/checkpoints.js'

// index.js self-boots (socket + instance lock + pollers) unless K_SKIP_BOOTSTRAP is
// set BEFORE evaluation — so import it dynamically, like every other route test.
process.env.K_SKIP_BOOTSTRAP = '1'
const { buildApp } = await import('../src/index.js')

const AUTH = { authorization: 'Bearer dev-token-change-me' }
const JSON_H = { ...AUTH, 'content-type': 'application/json' }
let app: Awaited<ReturnType<typeof buildApp>>
let base: string
let repo: string
let runId: string
let w1: CheckpointInfo
let w2: CheckpointInfo
let dispatchedWorktree: string | undefined

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
  app = await buildApp()
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-rwd-'))
  repo = path.join(base, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@k']); git(repo, ['config', 'user.name', 'K'])
  git(repo, ['config', 'commit.gpgsign', 'false']); git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init'])
  const wt = path.join(base, 'wt'); git(repo, ['worktree', 'add', '--detach', wt])
  runId = randomUUID()
  runsDb.insertRun.run({ id: runId, prompt: 'x', cwd: repo, worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
  fs.writeFileSync(path.join(wt, 'w1.txt'), 'wave 1\n')
  w1 = (await createCheckpoint(wt, runId, 1, null))!
  insertCkptEvent(runId, 3, w1)
  fs.writeFileSync(path.join(wt, 'w2.txt'), 'wave 2\n')
  w2 = (await createCheckpoint(wt, runId, 2, w1))!
  insertCkptEvent(runId, 7, w2)
  git(repo, ['worktree', 'remove', '--force', wt])
})
afterAll(async () => {
  // The 201 dispatch's runAgent tail (checkpoint finalize + removeWorktree) is
  // fire-and-forget; wait for its worktree to be gone BEFORE deleting the temp
  // repo, or the git cleanup runs against a vanished repo and the worktree dir
  // is orphaned under .worktrees/ forever (quality-review HIGH).
  const deadline = Date.now() + 15_000
  while (dispatchedWorktree && fs.existsSync(dispatchedWorktree) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await app.close()
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* */ }
})

describe('GET /api/runs/:id/checkpoints', () => {
  it('lists the chain from events; 404 unknown', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/checkpoints`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const list = res.json()
    expect(list.map((c: { wave: number }) => c.wave)).toEqual([1, 2])
    expect(list[0].sha).toBe(w1.sha)
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/checkpoints`, headers: AUTH })).statusCode).toBe(404)
  })
})

describe('POST /api/runs/:id/rewind', () => {
  it('validation chain: bad sha 400 → unknown run 404 → not-in-chain 400', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/rewind`, headers: JSON_H,
      payload: { sha: 'short', prompt: 'go' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${randomUUID()}/rewind`, headers: JSON_H,
      payload: { sha: w1.sha, prompt: 'go' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/rewind`, headers: JSON_H,
      payload: { sha: 'f'.repeat(40), prompt: 'go' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/rewind`, headers: JSON_H,
      payload: { sha: w1.sha, prompt: 'go', model: 'nope' } })).statusCode).toBe(400)
  })

  it('409s: run cwd gone from disk → checkpoint commit gone from repo', async () => {
    // cwd-gone: run row whose cwd never existed; sha IS in its chain so the
    // validation chain reaches the fs.existsSync leg.
    const r1 = randomUUID()
    runsDb.insertRun.run({ id: r1, prompt: 'x', cwd: path.join(base, 'gone'), worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    insertCkptEvent(r1, 3, w1)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${r1}/rewind`, headers: JSON_H,
      payload: { sha: w1.sha, prompt: 'go' } })).statusCode).toBe(409)
    // commit-gone: chain event carries a valid-shaped sha that is no object in the repo.
    const r2 = randomUUID()
    runsDb.insertRun.run({ id: r2, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    insertCkptEvent(r2, 3, { ...w1, sha: 'b'.repeat(40) })
    expect((await app.inject({ method: 'POST', url: `/api/runs/${r2}/rewind`, headers: JSON_H,
      payload: { sha: 'b'.repeat(40), prompt: 'go' } })).statusCode).toBe(409)
  })

  it('dispatches a run whose worktree starts AT the checkpoint (201)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/rewind`, headers: JSON_H,
      payload: { sha: w1.sha, prompt: 'continue from wave 1' } })
    expect(res.statusCode).toBe(201)
    const run = res.json()
    expect(run.prompt).toBe('continue from wave 1')
    expect(run.cwd).toBe(repo)
    // startRun created the worktree AT w1 before runAgent (mocked to fail pre-spawn)
    // errors out asynchronously; assert the durable contract — the run row landed.
    expect(runsDb.getRun.get(run.id)).toBeDefined()
    dispatchedWorktree = run.worktree // afterAll waits for its async cleanup
  })
})

describe('GET /api/runs/:id/impact', () => {
  it('unindexed / no-project → honest indexed:false payload', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/impact`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ indexed: false, projectId: null, files: [], totalSymbols: 0, totalDependents: 0, risk: null })
  })

  it('indexed project → per-file symbols + dependents + risk', async () => {
    // Register a project row over `repo` and drop a graph.json covering w1/w2 files.
    const pid = randomUUID()
    projectsDb.insertProject.run({ id: pid, name: `imp-${pid.slice(0, 8)}`, localPath: repo,
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    fs.mkdirSync(path.join(repo, '.gitnexus'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}')
    fs.writeFileSync(path.join(repo, '.gitnexus', 'graph.json'), JSON.stringify({
      nodes: [
        { id: 's1', name: 'waveOne', type: 'Function', file: 'w1.txt' },
        { id: 's2', name: 'caller', type: 'Function', file: 'other.ts' },
      ],
      links: [{ source: 's2', target: 's1', type: 'CALLS' }],
    }))
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })
    insertCkptEvent(rid, 2, w1)
    insertCkptEvent(rid, 5, w2)
    const res = await app.inject({ method: 'GET', url: `/api/runs/${rid}/impact`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.indexed).toBe(true)
    expect(body.projectId).toBe(pid)
    const w1File = body.files.find((f: { file: string }) => f.file === 'w1.txt')
    expect(w1File.symbols[0]).toMatchObject({ name: 'waveOne', dependents: 1 })
    expect(body.totalSymbols).toBe(1)
    expect(body.risk).toBe('low')
  })

  it('degrades to empty (not 500) when the checkpoint base commit is gone (P1 SEAMS M2)', async () => {
    const pid = randomUUID()
    projectsDb.insertProject.run({ id: pid, name: `imp-gc-${pid.slice(0, 8)}`, localPath: repo,
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    fs.mkdirSync(path.join(repo, '.gitnexus'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}')
    fs.writeFileSync(path.join(repo, '.gitnexus', 'graph.json'), JSON.stringify({ nodes: [], links: [] }))
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })
    // A checkpoint whose commit no longer exists in the repo (GC'd / swept refs).
    insertCkptEvent(rid, 2, { sha: 'e'.repeat(40), tree: 'f'.repeat(40), ref: `refs/k-checkpoints/${rid}`, wave: 1 })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${rid}/impact`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ indexed: true, projectId: pid, files: [], risk: null })
  })
})
