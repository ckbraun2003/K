// core/test/run-diff-context.test.ts — BE-2: ?context=N on the checkpoint diff +
// the file-at-ref endpoint powering DiffViewer v2 expand-context.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db, runsDb, eventsDb } from '../src/db.js'
import { createCheckpoint } from '../src/checkpoints.js'
import { parseNameStatusZ } from '../src/diff-parse.js'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const runId = `diffctx-${randomUUID().slice(0, 8)}`
let app: FastifyInstance
let repo: string

async function git(...args: string[]): Promise<void> { await execa('git', ['-C', repo, ...args]) }

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  app = await (await import('../src/index.js')).buildApp()

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-diffctx-'))
  await execa('git', ['init', '-b', 'main', repo])
  await git('config', 'user.email', 't@t.local'); await git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), Array.from({ length: 41 }, (_, i) => `line ${i}`).join('\n') + '\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'untouched\n')
  await git('add', '-A'); await git('commit', '-m', 'base')

  runsDb.insertRun.run({
    id: runId, prompt: 'p', cwd: repo, worktree: null, status: 'done', provider: 'claude',
    model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now(),
  })
  // one wave: modify a.txt mid-file, add c.txt, add a >512KB d.txt
  const lines = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').split('\n')
  lines[20] = 'line 20 CHANGED'
  fs.writeFileSync(path.join(repo, 'a.txt'), lines.join('\n'))
  fs.writeFileSync(path.join(repo, 'c.txt'), 'new file\n')
  fs.writeFileSync(path.join(repo, 'd.txt'), 'D'.repeat(600 * 1024))
  const ck = await createCheckpoint(repo, runId, 1, null)
  expect(ck).not.toBeNull()
  eventsDb.insertEvent.run({
    id: randomUUID(), runId, seq: 1, type: 'checkpoint', ts: Date.now(), raw: JSON.stringify(ck),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null,
    toolUseId: null, toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
    subagentType: null, childLabel: null, contextTokens: null,
  })
})
afterAll(async () => {
  await app.close()
  db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId)
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

function hunkFor(body: { files: Array<{ path: string; hunks: Array<{ lines: Array<{ kind: string }> }> }> }, p: string) {
  return body.files.find(f => f.path === p)!.hunks[0]
}

describe('GET /api/runs/:id/diff?context=N', () => {
  it('defaults to 3 context lines', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const ctx = hunkFor(res.json(), 'a.txt').lines.filter(l => l.kind === 'ctx')
    expect(ctx).toHaveLength(6) // 3 above + 3 below the single changed line
  })
  it('context=0 collapses to the changed lines only', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff?context=0`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(hunkFor(res.json(), 'a.txt').lines.filter(l => l.kind === 'ctx')).toHaveLength(0)
  })
  it('context=8 widens symmetrically', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff?context=8`, headers: AUTH })
    expect(hunkFor(res.json(), 'a.txt').lines.filter(l => l.kind === 'ctx')).toHaveLength(16)
  })
  it('rejects out-of-range / non-integer context', async () => {
    for (const bad of ['25', '-1', 'abc', '3.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff?context=${bad}`, headers: AUTH })
      expect(res.statusCode).toBe(400)
    }
  })
})

describe('GET /api/runs/:id/file', () => {
  const url = (q: string) => `/api/runs/${runId}/file?${q}`
  it('serves head content for an added file', async () => {
    const res = await app.inject({ method: 'GET', url: url('path=c.txt&ref=head'), headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ path: 'c.txt', ref: 'head', content: 'new file\n', truncated: false })
  })
  it('serves base content for a modified file', async () => {
    const res = await app.inject({ method: 'GET', url: url('path=a.txt&ref=base'), headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toContain('line 20\n')
    expect(res.json().content).not.toContain('CHANGED')
  })
  it('404s an added file at ref=base and any path outside the diff', async () => {
    expect((await app.inject({ method: 'GET', url: url('path=c.txt&ref=base'), headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: url('path=b.txt&ref=head'), headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: url('path=nope.txt&ref=head'), headers: AUTH })).statusCode).toBe(404)
  })
  it('400s a bad ref / missing path; 404s an unknown run', async () => {
    expect((await app.inject({ method: 'GET', url: url('path=a.txt&ref=HEAD'), headers: AUTH })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: url('ref=head'), headers: AUTH })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/file?path=a.txt&ref=head`, headers: AUTH })).statusCode).toBe(404)
  })
  it('caps content at 512KB with truncated:true', async () => {
    const res = await app.inject({ method: 'GET', url: url('path=d.txt&ref=head'), headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().truncated).toBe(true)
    expect(res.json().content.length).toBe(512 * 1024)
  })
})

describe('parseNameStatusZ', () => {
  it('parses plain and rename records', () => {
    const raw = 'M\0a.txt\0A\0c.txt\0R100\0old name.txt\0new name.txt\0D\0gone.txt\0'
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'M', oldPath: null, path: 'a.txt' },
      { status: 'A', oldPath: null, path: 'c.txt' },
      { status: 'R100', oldPath: 'old name.txt', path: 'new name.txt' },
      { status: 'D', oldPath: null, path: 'gone.txt' },
    ])
  })
})
