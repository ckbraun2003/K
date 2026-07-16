/**
 * A1 regression — artifact slug path traversal.
 *
 * The PUT/GET /api/artifacts/:slug routes must reject path-traversal slugs at
 * the boundary (400) and never write/read outside ARTIFACTS_DIR. A normal slug
 * still round-trips.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { artifactsRoutes } from '../src/routes/artifacts.js'
import { ARTIFACTS_DIR } from '../src/artifacts.js'
import { db } from '../src/db.js'

const slugs: string[] = []

afterAll(() => {
  for (const slug of slugs) {
    try { db.prepare('DELETE FROM artifacts WHERE slug = ?').run(slug) } catch { /* ignore */ }
    // ARTIFACTS_DIR is source-relative (not K_DATA_DIR), so clean the on-disk
    // md/html this round-trip wrote into the real artifacts/ dir.
    for (const ext of ['md', 'html']) {
      try { fs.rmSync(path.join(ARTIFACTS_DIR, `${slug}.${ext}`)) } catch { /* ignore */ }
    }
  }
})

async function makeApp() {
  const app = Fastify()
  await app.register(artifactsRoutes)
  return app
}

describe('PUT /api/artifacts/:slug — path-traversal rejection', () => {
  it('rejects traversal slugs with 400 and writes nothing', async () => {
    const app = await makeApp()
    try {
      // Raw URL paths that DO reach the handler with a traversal/invalid :slug → 400.
      // (A bare `..` is collapsed to the parent route by Fastify before it can
      //  bind as :slug, so it 404s instead — still never reaching saveArtifact.)
      for (const url of [
        '/api/artifacts/..%2f..%2f.env',
        '/api/artifacts/..%2fx',
        '/api/artifacts/.env',
        '/api/artifacts/foo.bar',
        '/api/artifacts/foo%20bar',
      ]) {
        const res = await app.inject({ method: 'PUT', url, payload: { md: '# hacked' } })
        expect(res.statusCode, url).toBe(400)
      }
    } finally {
      await app.close()
    }
  })

  it('GET rejects traversal slugs with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifacts/..%2f..%2fx' })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts a normal slug and round-trips via GET', async () => {
    const slug = 'a1-regression-ok'
    slugs.push(slug)
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/artifacts/${slug}`,
        payload: { md: '# Hello\n\nbody', title: 'Hello' },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().slug).toBe(slug)

      const get = await app.inject({ method: 'GET', url: `/api/artifacts/${slug}` })
      expect(get.statusCode).toBe(200)
      expect(get.json().md).toContain('# Hello')

      // v13 (D-117): list rows carry projectId/origin; a saveArtifact row is
      // harness-scoped and compiled.
      const list = await app.inject({ method: 'GET', url: '/api/artifacts' })
      expect(list.statusCode).toBe(200)
      const row = (list.json() as Array<{ slug: string; projectId: string | null; origin: string }>)
        .find(r => r.slug === slug)
      expect(row).toBeDefined()
      expect(row?.projectId).toBeNull()
      expect(row?.origin).toBe('compiled')
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/artifacts?projectId= — v13 filter boundary', () => {
  it('rejects an unknown projectId with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/artifacts?projectId=99999999-0000-0000-0000-000000000000',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('unknown projectId')
    } finally {
      await app.close()
    }
  })

  it('rejects a malformed projectId with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifacts?projectId=..%2fevil' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('invalid projectId')
    } finally {
      await app.close()
    }
  })
})
