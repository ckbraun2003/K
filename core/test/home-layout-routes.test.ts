/**
 * E3 — Home layout config KV routes.
 *
 * Tests GET /api/settings/home-layout and PUT /api/settings/home-layout.
 * Wipes the home_layout KV row before/after to keep tests isolated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const VALID = {
  widgets: [
    { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 },
    { id: 'needs_you', x: 2, y: 0, w: 1, h: 1 },
    { id: 'recent_activity', x: 0, y: 1, w: 2, h: 2 },
    { id: 'cost_today', x: 2, y: 1, w: 1, h: 1 },
    { id: 'personal_tasks', x: 2, y: 2, w: 1, h: 1 },
  ],
}

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
  db.prepare(`DELETE FROM app_config WHERE key = 'home_layout'`).run()
})

afterEach(() => {
  db.prepare(`DELETE FROM app_config WHERE key = 'home_layout'`).run()
})

describe('home layout routes', () => {
  it('GET before any PUT returns null', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/home-layout', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().layout).toBeNull()
  })

  it('PUT a valid layout round-trips through GET', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/settings/home-layout', headers: AUTH, payload: VALID })
    expect(put.statusCode).toBe(200)
    const got = (await app.inject({ method: 'GET', url: '/api/settings/home-layout', headers: AUTH })).json().layout
    expect(got).toEqual(VALID)
  })

  it('rejects overlap, out-of-bounds, and duplicate ids with 400', async () => {
    const overlap = { widgets: [{ id: 'notes', x: 0, y: 0, w: 2, h: 1 }, { id: 'schedule', x: 1, y: 0, w: 1, h: 1 }] }
    const oob = { widgets: [{ id: 'notes', x: 2, y: 2, w: 2, h: 1 }] }
    const dupe = { widgets: [{ id: 'notes', x: 0, y: 0, w: 1, h: 1 }, { id: 'notes', x: 1, y: 0, w: 1, h: 1 }] }
    for (const bad of [overlap, oob, dupe]) {
      expect((await app.inject({ method: 'PUT', url: '/api/settings/home-layout', headers: AUTH, payload: bad })).statusCode).toBe(400)
    }
  })

  it('a corrupt stored blob degrades to null, never a 500', async () => {
    db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('home_layout', '{not json')`).run()
    const res = await app.inject({ method: 'GET', url: '/api/settings/home-layout', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().layout).toBeNull()
  })
})
