/**
 * /api/claude/model route — runtime Claude default model over HTTP (P5.5).
 *
 * Drives the real Fastify app in-process (buildApp + inject), mirroring
 * app-routes.test.ts. GET returns the live model + the known-model options; PUT
 * validates against the KNOWN_MODELS registry (400 on unknown) and applies with
 * no restart. Supervisor is mocked so nothing spawns; DB is the vitest temp dir.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'
import { __resetConfigCache, claudeDefaultModel } from '../src/config-store.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  db.prepare(`DELETE FROM app_config`).run()
  __resetConfigCache()
  delete process.env.CLAUDE_MODEL
})

describe('GET /api/claude/model', () => {
  it('returns the live default model + the known-model options', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/claude/model', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { model: string; options: { id: string; label: string }[] }
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.options.map(o => o.id)).toContain('claude-opus-4-8')
    expect(body.options.length).toBeGreaterThanOrEqual(4)
  })
})

describe('PUT /api/claude/model', () => {
  it('sets a known model and it is reflected live (no restart)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/claude/model',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-8' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().model).toBe('claude-opus-4-8')
    // Live: the config-store getter reflects it immediately.
    expect(claudeDefaultModel()).toBe('claude-opus-4-8')
  })

  it('rejects an unknown model with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/claude/model',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { model: 'gpt-4o' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing model field with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/claude/model',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty-string model with 400 (fails min(1) before isKnownModel)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/claude/model',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { model: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})
