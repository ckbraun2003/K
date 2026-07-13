// core/test/autonomy-settings-route.test.ts — PATCH /api/autonomy (B4).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
})
afterAll(async () => {
  // Leave the shared K_DATA_DIR app_config as we found it (config-autonomy.test.ts precedent).
  setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
  __resetConfigCache()
  await app.close()
})
beforeEach(() => {
  setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
  __resetConfigCache()
})

describe('PATCH /api/autonomy', () => {
  it('enables the master switch and persists it (a subsequent GET reflects it)', async () => {
    const patch = await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: { enabled: true } })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().enabled).toBe(true)

    const get = await app.inject({ method: 'GET', url: '/api/autonomy', headers: AUTH })
    expect(get.json().enabled).toBe(true)
  })

  it('merges a partial patch onto the existing settings (untouched fields survive)', async () => {
    await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: { enabled: true, proposals: true } })
    const res = await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: { maxConcurrency: 4 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ enabled: true, proposals: true, maxConcurrency: 4 })
  })

  it('400s on an out-of-range value (maxConcurrency: 0)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: { maxConcurrency: 0 } })
    expect(res.statusCode).toBe(400)
    expect(typeof res.json().error).toBe('string')
  })

  it('400s on an empty patch', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('400s on an unrecognized field', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/autonomy', headers: AUTH, payload: { bogus: true } })
    expect(res.statusCode).toBe(400)
  })
})
