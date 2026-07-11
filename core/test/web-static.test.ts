import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { resolveWebDist, isPublicAssetPath } from '../src/web-static.js'

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('resolveWebDist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-webdist-'))

  it('returns null when K_WEB_DIST is unset (static serving off by default)', () => {
    expect(resolveWebDist({})).toBeNull()
  })

  it('returns null when K_WEB_DIST has no index.html (degrade, do not serve a broken shell)', () => {
    expect(resolveWebDist({ K_WEB_DIST: dir })).toBeNull()
  })

  it('resolves the dir when K_WEB_DIST holds an index.html', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>K</title>')
    expect(resolveWebDist({ K_WEB_DIST: dir })).toBe(path.resolve(dir))
  })
})

describe('isPublicAssetPath', () => {
  it('exempts read requests for SPA shell + assets (no /api, no /ws)', () => {
    expect(isPublicAssetPath('GET', '/')).toBe(true)
    expect(isPublicAssetPath('GET', '/assets/index-abc123.js')).toBe(true)
    expect(isPublicAssetPath('GET', '/favicon.svg')).toBe(true)
    expect(isPublicAssetPath('HEAD', '/some/spa/route')).toBe(true)
    expect(isPublicAssetPath('GET', '/index.html?v=1')).toBe(true) // query ignored
  })

  it('never exempts the data plane — /api and /ws stay gated', () => {
    expect(isPublicAssetPath('GET', '/api/runs')).toBe(false)
    expect(isPublicAssetPath('GET', '/api')).toBe(false)
    expect(isPublicAssetPath('GET', '/ws')).toBe(false)
    expect(isPublicAssetPath('GET', '/ws/terminal')).toBe(false)
    // a dot-segment / query trick can't smuggle past the /api guard
    expect(isPublicAssetPath('GET', '/api/../api/runs')).toBe(false)
    // mixed-case look-alikes are treated as gated (not served the public shell),
    // keeping the "sensitive side of the line" answer consistent
    expect(isPublicAssetPath('GET', '/API/runs')).toBe(false)
    expect(isPublicAssetPath('GET', '/Ws/terminal')).toBe(false)
    // network-path reference: `//api/x` parses with `api` as the AUTHORITY, so a
    // naive `.pathname` (`/x`) would drop the `/api` prefix and mis-serve the public
    // shell — must fail closed. Same for the `/\api/x` backslash variant (the http
    // parser folds `\`→`/`) and a bare `//ws`.
    expect(isPublicAssetPath('GET', '//api/runs')).toBe(false)
    expect(isPublicAssetPath('GET', '/\\api/runs')).toBe(false)
    expect(isPublicAssetPath('GET', '//ws')).toBe(false)
    expect(isPublicAssetPath('GET', '//health')).toBe(false)
  })

  it('never exempts write methods (only GET/HEAD are static reads)', () => {
    expect(isPublicAssetPath('POST', '/')).toBe(false)
    expect(isPublicAssetPath('DELETE', '/anything')).toBe(false)
  })
})

// ── Integration: buildApp serves the SPA same-origin while /api stays gated ──

describe('same-origin static serving (buildApp)', () => {
  let app: FastifyInstance
  let webDist: string

  beforeAll(async () => {
    webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'k-webdist-int-'))
    fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>K Deck</title><div id=root>')
    fs.mkdirSync(path.join(webDist, 'assets'))
    fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log("k")')

    process.env.K_SKIP_BOOTSTRAP = '1'
    process.env.K_WEB_DIST = webDist
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    delete process.env.K_WEB_DIST
  })

  it('serves index.html at / with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('K Deck')
  })

  it('serves a hashed asset with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log')
  })

  it('falls back to index.html for a client route (hash-router deep link safety)', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/xyz' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('K Deck')
  })

  it('STILL requires a token for /api (static serving does not open the data plane)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics/summary' })
    expect(res.statusCode).toBe(401)
  })

  it('an unknown /api path is a 401 (auth) not an index.html fallback', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(401)
  })

  it('a //api network-path reference does not bypass auth (fails closed, not the public shell)', async () => {
    // `//api/...` parses with `api` as the authority — the exemption classifier must
    // NOT treat it as a public asset. Before the fix this returned 200 (index.html).
    const res = await app.inject({ method: 'GET', url: '//api/metrics/summary' })
    expect(res.statusCode).not.toBe(200)
  })

  it('/health stays public and JSON (not shadowed by the static wildcard)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })
})
