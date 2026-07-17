/**
 * Background preference (usability-access B.3) — app_config-backed variant
 * (`ui.background`, default `DEFAULT_BACKGROUND`) plus the
 * GET/PUT /api/settings/background route pair. Mirrors the
 * settings-route.test.ts bare-Fastify harness (no auth — settingsRoutes has
 * none of its own).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { settingsRoutes } from '../src/routes/settings.js'
import { backgroundVariant, setBackgroundVariant, __resetConfigCache } from '../src/config-store.js'

// setBackgroundVariant writes straight through to app_config (no cache layer),
// so — unlike the cached getters elsewhere in this store — a prior test's write
// persists across the whole file, not just until __resetConfigCache(). The route
// tests below set their own starting variant explicitly rather than relying on
// "nothing set yet" (which only the very first test in the file can assume).

beforeEach(() => __resetConfigCache())

async function makeApp() {
  const app = Fastify()
  await app.register(settingsRoutes)
  return app
}

describe('backgroundVariant / setBackgroundVariant (config-store)', () => {
  it('defaults to galaxy and round-trips', () => {
    expect(backgroundVariant()).toBe('galaxy')
    setBackgroundVariant('aurora')
    __resetConfigCache()
    expect(backgroundVariant()).toBe('aurora')
  })
})

describe('GET/PUT /api/settings/background', () => {
  it('GET returns the current variant + the full options list', async () => {
    setBackgroundVariant('galaxy')
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings/background' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.variant).toBe('galaxy')
      expect(body.options).toEqual(['galaxy', 'aurora', 'blobs', 'solid'])
    } finally {
      await app.close()
    }
  })

  it('PUT sets the variant and GET reflects it afterward', async () => {
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { variant: 'blobs' },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().variant).toBe('blobs')

      const get = await app.inject({ method: 'GET', url: '/api/settings/background' })
      expect(get.json().variant).toBe('blobs')
    } finally {
      await app.close()
    }
  })

  it('PUT rejects an invalid variant with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { variant: 'nebula' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
