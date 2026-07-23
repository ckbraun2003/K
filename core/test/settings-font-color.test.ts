/**
 * Font-colour override route (ui-adjustments Round 2) — GET/PUT
 * /api/settings/font-color. Mirrors settings-background.test.ts's bare-Fastify
 * harness (no auth — settingsRoutes has none of its own).
 *
 * Storage-layer behavior (round-trip, corrupt fallback) is covered in
 * config-store-fontcolor.test.ts; this file is route-level only.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { settingsRoutes } from '../src/routes/settings.js'
import { setFontColorSettings, __resetConfigCache } from '../src/config-store.js'

beforeEach(() => {
  __resetConfigCache()
})

async function makeApp() {
  const app = Fastify()
  await app.register(settingsRoutes)
  return app
}

describe('GET/PUT /api/settings/font-color', () => {
  it('GET returns the default ({ color: null }) when nothing is stored', async () => {
    setFontColorSettings({ color: null })
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings/font-color' })
      expect(res.statusCode).toBe(200)
      expect(res.json().settings).toEqual({ color: null })
    } finally {
      await app.close()
    }
  })

  it('PUT a valid 6-digit hex persists and GET reflects it afterward', async () => {
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/font-color',
        payload: { color: '#ff00aa' },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings).toEqual({ color: '#ff00aa' })

      const get = await app.inject({ method: 'GET', url: '/api/settings/font-color' })
      expect(get.json().settings).toEqual({ color: '#ff00aa' })
    } finally {
      await app.close()
    }
  })

  it('PUT { color: null } clears a previously-set override', async () => {
    setFontColorSettings({ color: '#123456' })
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/font-color',
        payload: { color: null },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings).toEqual({ color: null })

      const get = await app.inject({ method: 'GET', url: '/api/settings/font-color' })
      expect(get.json().settings).toEqual({ color: null })
    } finally {
      await app.close()
    }
  })

  it('PUT rejects a malformed hex (missing #) with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/font-color',
        payload: { color: 'ff00aa' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('PUT rejects a 3-digit shorthand hex with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/font-color',
        payload: { color: '#abc' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('PUT strips an unknown extra key rather than rejecting (FontColorSettingsSchema is not .strict())', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/font-color',
        payload: { color: '#ffffff', extra: 'nope' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().settings).toEqual({ color: '#ffffff' })
    } finally {
      await app.close()
    }
  })
})
