/**
 * Wave C6 — GET /api/projects/github (fleet batch) route test.
 *
 * The Home/Projects grid used to fire one /api/projects/:id/github request per
 * card (an N-request fan-out that exhausted the browser socket pool under load).
 * The batch route collapses that to a single request returning a map keyed by
 * project id. This test pins:
 *   1. the batch route returns a map of id → GithubStatus for every project,
 *   2. each entry equals the per-id route's payload (same cached read),
 *   3. the static `github` segment is NOT shadowed by the `:id` param route.
 *
 * Builds the real Fastify app in-process and drives it with app.inject (no
 * socket, no poller). DB is isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, githubDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const ids: string[] = []

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  // Three projects with cached pr/ci so getGithubStatus returns real payloads.
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    const id = uuid()
    ids.push(id)
    projectsDb.insertProject.run({
      id,
      name: `gh-fleet-test-${id.slice(0, 8)}`,
      localPath: `/tmp/gh-fleet-${i}`,
      githubRemote: `https://github.com/acme/repo${i}`,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: now,
    })
    githubDb.upsertGithubCache.run({ projectId: id, kind: 'pr', payload: JSON.stringify([{ number: i, title: `pr${i}`, state: 'OPEN', url: '', checks: 'passing' }]), fetchedAt: now })
    githubDb.upsertGithubCache.run({ projectId: id, kind: 'ci', payload: JSON.stringify([]), fetchedAt: now })
  }
})

afterAll(async () => {
  for (const id of ids) {
    try { db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  await app.close()
})

describe('GET /api/projects/github (fleet batch)', () => {
  it('returns a map keyed by project id for every project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/github', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const map = res.json() as Record<string, unknown>
    // The static `github` route must NOT be swallowed by `:id` (a 404 "not found").
    expect(map).not.toHaveProperty('error')
    for (const id of ids) expect(map).toHaveProperty(id)
  })

  it('each entry equals the per-id route payload (same cached read)', async () => {
    const batch = (await app.inject({ method: 'GET', url: '/api/projects/github', headers: AUTH })).json() as Record<string, unknown>
    for (const id of ids) {
      const single = (await app.inject({ method: 'GET', url: `/api/projects/${id}/github`, headers: AUTH })).json()
      expect(batch[id]).toEqual(single)
    }
  })

  it('entries carry the cached prs/ci/fetchedAt shape', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/projects/github', headers: AUTH })).json() as Record<string, { prs: unknown[]; ci: unknown[]; fetchedAt: number | null }>
    const entry = map[ids[0]]
    expect(Array.isArray(entry.prs)).toBe(true)
    expect(Array.isArray(entry.ci)).toBe(true)
    expect(entry.prs.length).toBe(1)
    expect(typeof entry.fetchedAt).toBe('number')
  })
})
