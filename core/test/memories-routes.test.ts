/**
 * User-memories CRUD routes (UI Simplification, Task 3) —
 * GET/POST /api/memories, PATCH/DELETE /api/memories/:id
 *
 * Same harness shape as k-threads-routes.test.ts: builds the real Fastify app in-process
 * (buildApp) and drives it with app.inject. No supervisor mock needed — these routes are
 * pure DB CRUD, no dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

function resetState() {
  db.prepare('DELETE FROM user_memories').run()
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  resetState()
})

afterAll(async () => {
  resetState()
  await app.close()
})

describe('POST /api/memories + GET /api/memories', () => {
  it('POST creates; GET lists updated-desc', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: 'prefers dark roast coffee' } })
    expect(a.statusCode).toBe(201)
    expect(a.json().content).toBe('prefers dark roast coffee')
    expect(a.json().sourceThreadId).toBeNull()
    const b = await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: 'timezone is America/Chicago' } })
    expect(b.statusCode).toBe(201)
    const list = (await app.inject({ method: 'GET', url: '/api/memories', headers: AUTH })).json().memories
    expect(list[0].content).toBe('timezone is America/Chicago') // newest updated first
  })
})

describe('PATCH /api/memories/:id', () => {
  it('PATCH edits content and bumps updatedAt; unknown id 404', async () => {
    const m = (await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: 'old' } })).json()
    const patched = await app.inject({ method: 'PATCH', url: `/api/memories/${m.id}`, headers: AUTH, payload: { content: 'new' } })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().content).toBe('new')
    expect(patched.json().updatedAt).toBeGreaterThanOrEqual(m.updatedAt)
    expect((await app.inject({ method: 'PATCH', url: '/api/memories/um-nope', headers: AUTH, payload: { content: 'x' } })).statusCode).toBe(404)
  })
})

describe('DELETE /api/memories/:id', () => {
  it('DELETE removes; unknown id 404; empty/oversize content 400', async () => {
    const m = (await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: 'temp' } })).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${m.id}`, headers: AUTH })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${m.id}`, headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/memories', headers: AUTH, payload: { content: 'x'.repeat(2001) } })).statusCode).toBe(400)
  })
})
