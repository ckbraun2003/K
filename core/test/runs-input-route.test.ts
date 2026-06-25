/**
 * Wave A3 — route coverage for the interactive-HITL endpoints.
 *
 * POST /api/runs/:id/input  — 404 unknown · 400 bad body · 409 not awaiting · 204 ok
 * POST /api/runs/:id/end    — 404 unknown · 200 { ended }
 *
 * Builds the real Fastify app (buildApp) and drives it with app.inject. supervisor
 * is mocked so the route logic is tested in isolation — sendInput/endSession return
 * values are scripted per test to drive the status-code branches (mirrors
 * runs-model.test.ts / delete-routes.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return {
    ...actual,
    startRun: vi.fn(async () => ({ id: 'mock-run' })),
    kill: vi.fn(() => false),
    sendInput: vi.fn(() => true),
    endSession: vi.fn(() => true),
  }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

/** Insert a real run row (the route's 404 guard hits the DB before calling supervisor). */
function seedRun(status: string): string {
  const id = uuid()
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, 'p', '/tmp', status, Date.now())
  return id
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('POST /api/runs/:id/input', () => {
  it('404 for an unknown run id', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${uuid()}/input`, headers: AUTH, payload: { text: 'hi' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('400 for an empty body text', async () => {
    const id = seedRun('awaiting_input')
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${id}/input`, headers: AUTH, payload: { text: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 for a missing text field', async () => {
    const id = seedRun('awaiting_input')
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${id}/input`, headers: AUTH, payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('409 when sendInput reports the run is not awaiting input', async () => {
    const { sendInput } = await import('../src/supervisor.js')
    vi.mocked(sendInput).mockReturnValueOnce(false)
    const id = seedRun('running')
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${id}/input`, headers: AUTH, payload: { text: 'late answer' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/not awaiting input/i)
  })

  it('204 when the turn is accepted', async () => {
    const { sendInput } = await import('../src/supervisor.js')
    vi.mocked(sendInput).mockReturnValueOnce(true)
    const id = seedRun('awaiting_input')
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${id}/input`, headers: AUTH, payload: { text: 'my answer' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(vi.mocked(sendInput)).toHaveBeenCalledWith(id, 'my answer')
  })
})

describe('POST /api/runs/:id/end', () => {
  it('404 for an unknown run id', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${uuid()}/end`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('200 { ended: true } when the session was ended', async () => {
    const { endSession } = await import('../src/supervisor.js')
    vi.mocked(endSession).mockReturnValueOnce(true)
    const id = seedRun('awaiting_input')
    const res = await app.inject({ method: 'POST', url: `/api/runs/${id}/end`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ended: true })
  })

  it('200 { ended: false } for a non-interactive run', async () => {
    const { endSession } = await import('../src/supervisor.js')
    vi.mocked(endSession).mockReturnValueOnce(false)
    const id = seedRun('running')
    const res = await app.inject({ method: 'POST', url: `/api/runs/${id}/end`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ended: false })
  })
})
