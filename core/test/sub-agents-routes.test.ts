/**
 * Sub-agent REST surface (Orchestration Program Phase 2, Lane B Task B.2) —
 * GET /api/sub-agents (list/one), POST (create/clone), PATCH, DELETE.
 *
 * Mutations are operator-only: a K-native id (`k:<name>`, source:'k') 403s on
 * PATCH/DELETE/POST-name-collision — the registry (core/src/sub-agents.ts,
 * frozen W0 interface) throws on those, and this route's mapSubAgentError
 * classifies "K-native worker" messages as 403.
 *
 * Same harness shape as memories-routes.test.ts: buildApp() in-process, no
 * supervisor mock (pure DB CRUD + disk-parsed K-native reads, no dispatch).
 * Cleanup mirrors sub-agents.test.ts — every operator row THIS suite creates
 * is deleted in afterAll so nothing leaks into other test files sharing the
 * on-disk SQLite file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const createdIds: string[] = []

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  for (const id of createdIds) db.prepare('DELETE FROM sub_agent_defs WHERE id = ?').run(id)
  await app.close()
})

describe('GET /api/sub-agents', () => {
  it('lists K-native workers (source:k) plus any operator rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sub-agents', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{ id: string; name: string; source: string }>
    const implementer = list.find(a => a.name === 'implementer')
    expect(implementer).toBeDefined()
    expect(implementer!.source).toBe('k')
    expect(implementer!.id).toBe('k:implementer')
  })
})

describe('GET /api/sub-agents/:id', () => {
  it('returns one K-native worker by id; 404 for an unknown id', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/sub-agents/k:implementer', headers: AUTH })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().name).toBe('implementer')

    const missing = await app.inject({ method: 'GET', url: '/api/sub-agents/no-such-id', headers: AUTH })
    expect(missing.statusCode).toBe(404)
  })
})

describe('POST /api/sub-agents — plain create', () => {
  it('creates an operator worker (201); rejects a K-native-name collision (403); rejects an incomplete body (400)', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-op-${Date.now()}`, role: 'A test worker', prompt: 'You are a test worker.' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(body.source).toBe('operator')
    expect(body.enabled).toBe(true)
    createdIds.push(body.id)

    const collision = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: 'implementer', role: 'collision attempt', prompt: 'x' },
    })
    expect(collision.statusCode).toBe(403)

    const incomplete = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: 'missing-role-and-prompt' },
    })
    expect(incomplete.statusCode).toBe(400)
  })
})

describe('POST /api/sub-agents — clone (fork-to-edit)', () => {
  it('forks a K-native worker into a new operator row carrying its role/prompt/tools', async () => {
    const forked = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `implementer-fork-${Date.now()}`, cloneFrom: 'k:implementer' },
    })
    expect(forked.statusCode).toBe(201)
    const body = forked.json()
    expect(body.source).toBe('operator')
    expect(body.prompt.length).toBeGreaterThan(0)
    expect(body.role).toContain('Implements ONE task')
    createdIds.push(body.id)

    const unknownSource = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `clone-of-nothing-${Date.now()}`, cloneFrom: 'no-such-worker' },
    })
    expect(unknownSource.statusCode).toBe(404)
  })
})

describe('PATCH /api/sub-agents/:id', () => {
  it('patches an operator worker (200); 403 on a K-native id; 404 on an unknown operator id', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-patch-${Date.now()}`, role: 'before', prompt: 'p' },
    })).json()
    createdIds.push(created.id)

    const patched = await app.inject({
      method: 'PATCH', url: `/api/sub-agents/${created.id}`, headers: AUTH,
      payload: { role: 'after', enabled: false },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().role).toBe('after')
    expect(patched.json().enabled).toBe(false)

    const kNative = await app.inject({
      method: 'PATCH', url: '/api/sub-agents/k:implementer', headers: AUTH,
      payload: { role: 'hacked' },
    })
    expect(kNative.statusCode).toBe(403)

    const unknown = await app.inject({
      method: 'PATCH', url: '/api/sub-agents/no-such-id', headers: AUTH,
      payload: { role: 'x' },
    })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('DELETE /api/sub-agents/:id', () => {
  it('deletes an operator worker (204, then 404); 403 on a K-native id', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-delete-${Date.now()}`, role: 'r', prompt: 'p' },
    })).json()

    const del = await app.inject({ method: 'DELETE', url: `/api/sub-agents/${created.id}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    const gone = await app.inject({ method: 'GET', url: `/api/sub-agents/${created.id}`, headers: AUTH })
    expect(gone.statusCode).toBe(404)

    const kNative = await app.inject({ method: 'DELETE', url: '/api/sub-agents/k:planner', headers: AUTH })
    expect(kNative.statusCode).toBe(403)
  })
})
