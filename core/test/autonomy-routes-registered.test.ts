// core/test/autonomy-routes-registered.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'          // MUST precede the import so start()/listen() is skipped
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
})
afterAll(async () => { await app.close() })

describe('autonomy routes registered', () => {
  it('GET /api/autonomy returns default-OFF settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/autonomy', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe(false)
  })
  it('GET /api/budget returns a status envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budget', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().org.state).toBe('ok')
  })
})
