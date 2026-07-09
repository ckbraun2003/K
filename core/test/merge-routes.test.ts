/**
 * P2 E-06 — merge.ts route tests: one-click merge + auto-merge toggle.
 *
 * github.js is PARTIALLY mocked — ONLY the two gh-invoking helpers
 * (fetchPrMergeReadiness, mergePr) become spies; everything else stays REAL.
 * These tests cover the ROUTE MAPPING (guard order, status codes, body shape) —
 * the argv/execa contracts of the helpers are covered by create-pr-style
 * execa-mock tests + the live smoke. No gh, no network.
 *
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { MergePrResultSchema } from '@k/shared'

// index.js fires bootstrap at import time unless K_SKIP_BOOTSTRAP=1.
vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

// Replace ONLY the two gh-invoking helpers with fakes; spread importActual so
// getProject-facing reads (getGithubStatus, publishCommitStatus, …) stay real.
const { readinessMock, mergeMock } = vi.hoisted(() => ({
  readinessMock: vi.fn(),
  mergeMock: vi.fn(),
}))
vi.mock('../src/github.js', async () => {
  const actual = await vi.importActual<typeof import('../src/github.js')>('../src/github.js')
  return { ...actual, fetchPrMergeReadiness: readinessMock, mergePr: mergeMock }
})

import { db, projectsDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
let projectWithRemote: string
let projectNoRemote: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  projectWithRemote = uuid()
  projectsDb.insertProject.run({
    id: projectWithRemote,
    name: `merge-remote-${projectWithRemote.slice(0, 8)}`,
    localPath: process.cwd(),
    githubRemote: 'owner/repo',
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })

  projectNoRemote = uuid()
  projectsDb.insertProject.run({
    id: projectNoRemote,
    name: `merge-noremote-${projectNoRemote.slice(0, 8)}`,
    localPath: process.cwd(),
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
})

afterAll(async () => {
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectWithRemote) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectNoRemote) } catch { /* ignore */ }
  await app.close()
})

beforeEach(() => {
  readinessMock.mockReset()
  mergeMock.mockReset()
})

describe('POST /api/projects/:id/prs/:number/merge', () => {
  it('404 for an unknown project (before any gh readback)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${uuid()}/prs/1/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(404)
    expect(readinessMock).not.toHaveBeenCalled()
  })

  it('400 when the project has no githubRemote', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectNoRemote}/prs/1/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/remote/i)
    expect(readinessMock).not.toHaveBeenCalled()
  })

  it('400 when the PR number is not a positive integer', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/abc/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/number/i)
    expect(readinessMock).not.toHaveBeenCalled()
  })

  it('409 when the PR is not OPEN (state MERGED) — no merge attempted', async () => {
    readinessMock.mockResolvedValueOnce({ state: 'MERGED', checks: 'passing' })
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/5/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/not open/i)
    expect(mergeMock).not.toHaveBeenCalled()
  })

  it('409 when checks are pending — verdict carried in the message', async () => {
    readinessMock.mockResolvedValueOnce({ state: 'OPEN', checks: 'pending' })
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/5/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('pending')
    expect(mergeMock).not.toHaveBeenCalled()
  })

  it('409 when checks are failing — verdict carried in the message', async () => {
    readinessMock.mockResolvedValueOnce({ state: 'OPEN', checks: 'failing' })
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/5/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('failing')
    expect(mergeMock).not.toHaveBeenCalled()
  })

  it('200 on a green readback: merges and returns { merged, number }', async () => {
    readinessMock.mockResolvedValueOnce({ state: 'OPEN', checks: 'passing' })
    mergeMock.mockResolvedValueOnce(undefined)
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/5/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(MergePrResultSchema.safeParse(body).success).toBe(true)
    expect(body).toEqual({ merged: true, number: 5 })
    expect(mergeMock).toHaveBeenCalledWith('owner/repo', 5)
  })

  it('502 when the gh merge fails (sanitized)', async () => {
    readinessMock.mockResolvedValueOnce({ state: 'OPEN', checks: 'passing' })
    mergeMock.mockRejectedValueOnce(new Error('gh pr merge failed'))
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectWithRemote}/prs/5/merge`, headers: AUTH,
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/merge failed/i)
  })
})

describe('PATCH /api/projects/:id/auto-merge', () => {
  it('flips projects.auto_merge and the returned Project echoes autoMerge', async () => {
    const on = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectWithRemote}/auto-merge`,
      headers: AUTH, payload: { enabled: true },
    })
    expect(on.statusCode).toBe(200)
    expect(on.json().autoMerge).toBe(true)
    expect(Number((db.prepare('SELECT auto_merge FROM projects WHERE id = ?').get(projectWithRemote) as { auto_merge: number }).auto_merge)).toBe(1)

    const off = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectWithRemote}/auto-merge`,
      headers: AUTH, payload: { enabled: false },
    })
    expect(off.statusCode).toBe(200)
    // default-OFF projection: auto_merge=0 omits the field entirely
    expect(off.json().autoMerge).toBeUndefined()
    expect(Number((db.prepare('SELECT auto_merge FROM projects WHERE id = ?').get(projectWithRemote) as { auto_merge: number }).auto_merge)).toBe(0)
  })

  it('400 on a missing/invalid body ({} has no enabled)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectWithRemote}/auto-merge`,
      headers: AUTH, payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 for an unknown project (body valid, existence checked after)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${uuid()}/auto-merge`,
      headers: AUTH, payload: { enabled: true },
    })
    expect(res.statusCode).toBe(404)
  })
})
