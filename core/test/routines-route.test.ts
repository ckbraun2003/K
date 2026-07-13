// core/test/routines-route.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
let app: FastifyInstance
beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
})
afterAll(async () => { await app.close() })

describe('routines routes', () => {
  it('GET /api/routines returns an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routines', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
  it('parse-cron 400s an empty body and a phrase that cannot be translated', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/routines/parse-cron', headers: AUTH, payload: {} })).statusCode).toBe(400)
    // The rules-only translator returns '' for an unmappable phrase → invalid cron → 400.
    expect((await app.inject({ method: 'POST', url: '/api/routines/parse-cron', headers: AUTH, payload: { text: 'whenever' } })).statusCode).toBe(400)
  })
})
