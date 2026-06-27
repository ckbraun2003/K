/**
 * Wave A1 — POST /api/runs model validation.
 *
 * The route validates `model` against the known-model registry at the boundary
 * (lessons.md): a known id flows through to startRun (201); an unknown id is
 * rejected (400 "unknown model") before any spawn. supervisor.startRun is mocked
 * so no real agent process is launched — mirrors delete-routes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

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

describe('POST /api/runs model validation', () => {
  it('201 for a known model id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { prompt: 'do something', model: 'claude-opus-4-8' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('400 "unknown model" for an unknown model id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { prompt: 'do something', model: 'gpt-9' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'unknown model' })
  })

  it('201 and threads preferLocal through to startRun', async () => {
    const { startRun } = await import('../src/supervisor.js')
    const mock = vi.mocked(startRun)
    mock.mockClear()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { prompt: 'do something', preferLocal: true },
    })
    expect(res.statusCode).toBe(201)
    expect(mock).toHaveBeenCalledWith('do something', expect.objectContaining({ preferLocal: true }))
  })
})
