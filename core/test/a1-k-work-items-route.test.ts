/**
 * A1 — durable work-items HTTP surface (routes/k.ts).
 *
 * Builds the real Fastify app in-process (buildApp) and drives it with app.inject —
 * same bootstrap as k-route.test.ts (K_SKIP_BOOTSTRAP set before importing index).
 * These routes never dispatch, so no supervisor mock is needed. All created rows are
 * cleaned in afterAll (shared K_DATA_DIR singleton, serial fork).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import { db, workItemsDb } from '../src/db.js'
import type { WorkItem } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const TITLE_TAG = `a1-route-${uuid().slice(0, 8)}`

let app: FastifyInstance
const runScopedId = uuid()

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  // A run-scoped kstore ticket — must be UNREACHABLE from the durable-only HTTP surface.
  const now = Date.now()
  workItemsDb.insertWorkItem.run({
    id: runScopedId, runId: null, title: `${TITLE_TAG} run-scoped`, body: null,
    status: 'open', scope: 'run', createdAt: now, updatedAt: now,
  })
})

afterAll(async () => {
  db.prepare(`DELETE FROM work_items WHERE title LIKE ?`).run(`${TITLE_TAG}%`)
  await app.close()
})

describe('auth', () => {
  it('401 without the Bearer header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/k/work-items' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /api/k/work-items', () => {
  it('POST {title} → 201, scope personal, runId null, status open', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} personal` },
    })
    expect(res.statusCode).toBe(201)
    const item = res.json() as WorkItem
    expect(item.scope).toBe('personal')
    expect(item.runId).toBeNull()
    expect(item.status).toBe('open')
  })

  it('POST {title, scope:org} → 201, scope org', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} org`, scope: 'org' },
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as WorkItem).scope).toBe('org')
  })

  it('POST {title, scope:run} → 400 (run is not a durable scope)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} nope`, scope: 'run' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST without a title → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/k/work-items', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/k/work-items', () => {
  it('lists both personal + org durable items; ?scope=org filters; ?status=open filters; bad ?scope → 400', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/k/work-items', headers: AUTH })
    expect(all.statusCode).toBe(200)
    const items = all.json() as WorkItem[]
    expect(Array.isArray(items)).toBe(true)
    expect(items.some(i => i.scope === 'personal')).toBe(true)
    expect(items.some(i => i.scope === 'org')).toBe(true)
    // never leaks the run-scoped ticket
    expect(items.some(i => i.id === runScopedId)).toBe(false)

    const orgOnly = await app.inject({ method: 'GET', url: '/api/k/work-items?scope=org', headers: AUTH })
    expect(orgOnly.statusCode).toBe(200)
    expect((orgOnly.json() as WorkItem[]).every(i => i.scope === 'org')).toBe(true)

    const openOnly = await app.inject({ method: 'GET', url: '/api/k/work-items?status=open', headers: AUTH })
    expect(openOnly.statusCode).toBe(200)
    expect((openOnly.json() as WorkItem[]).every(i => i.status === 'open')).toBe(true)

    const bad = await app.inject({ method: 'GET', url: '/api/k/work-items?scope=project', headers: AUTH })
    expect(bad.statusCode).toBe(400)
    const badStatus = await app.inject({ method: 'GET', url: '/api/k/work-items?status=bogus', headers: AUTH })
    expect(badStatus.statusCode).toBe(400)
  })
})

describe('PATCH /api/k/work-items/:id', () => {
  it('PATCH {status:done} → 200 status done', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} patch me` },
    })
    const id = (created.json() as WorkItem).id
    const res = await app.inject({
      method: 'PATCH', url: `/api/k/work-items/${id}`, headers: AUTH, payload: { status: 'done' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as WorkItem).status).toBe('done')
  })

  it('PATCH an unknown id → 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/k/work-items/${uuid()}`, headers: AUTH, payload: { status: 'done' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH a run-scoped kstore item → 404 (durable-only surface)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/k/work-items/${runScopedId}`, headers: AUTH, payload: { status: 'done' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH with a bad status → 400', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} bad patch` },
    })
    const id = (created.json() as WorkItem).id
    const res = await app.inject({
      method: 'PATCH', url: `/api/k/work-items/${id}`, headers: AUTH, payload: { status: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })
})
