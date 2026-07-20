/**
 * Background wallpaper settings model (usability-access B.3 follow-up) —
 * GET/PUT /api/settings/background + PUT/GET /api/settings/background/image.
 * Mirrors the settings-route.test.ts bare-Fastify harness (no auth —
 * settingsRoutes has none of its own).
 *
 * Storage-layer behavior (legacy migration, corrupt fallback, JSON round-trip)
 * is covered in config-store-background.test.ts; this file is route-level only.
 *
 * K_DATA_DIR is an isolated temp dir (set globally by vitest.config.ts) and is
 * shared across the whole gating run (singleFork), so tests never assume "no
 * wallpaper uploaded yet" implicitly — a beforeEach wipes any wallpaper.* file
 * before every test, and each test uploads its own fixture when it needs one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import Fastify from 'fastify'
import { GRADIENT_PRESETS, BACKGROUND_KINDS } from '@k/shared'
import { settingsRoutes } from '../src/routes/settings.js'
import { backgroundSettings, setBackgroundSettings, wallpaperDir, __resetConfigCache } from '../src/config-store.js'

// A real (tiny, valid) 1x1 transparent PNG, base64-encoded.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`

async function clearWallpaperFiles() {
  const dir = wallpaperDir()
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries.filter(f => f.startsWith('wallpaper.')).map(f => fs.unlink(path.join(dir, f)).catch(() => {})),
  )
}

beforeEach(async () => {
  __resetConfigCache()
  await clearWallpaperFiles()
})

async function makeApp() {
  const app = Fastify()
  await app.register(settingsRoutes)
  return app
}

describe('GET/PUT /api/settings/background — settings model', () => {
  it('GET returns the default settings + the full preset/kind lists', async () => {
    setBackgroundSettings({ kind: 'solid', preset: null, imageVersion: null })
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings/background' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.settings).toEqual({ kind: 'solid', preset: null, imageVersion: null })
      expect(body.presets).toEqual([...GRADIENT_PRESETS])
      expect(body.kinds).toEqual([...BACKGROUND_KINDS])
    } finally {
      await app.close()
    }
  })

  it('PUT {kind:solid,preset:null} persists and GET reflects it afterward', async () => {
    setBackgroundSettings({ kind: 'gradient', preset: 'dusk', imageVersion: null })
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { kind: 'solid', preset: null },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings).toEqual({ kind: 'solid', preset: null, imageVersion: null })

      const get = await app.inject({ method: 'GET', url: '/api/settings/background' })
      expect(get.json().settings).toEqual({ kind: 'solid', preset: null, imageVersion: null })
    } finally {
      await app.close()
    }
  })

  it('PUT preserves the current imageVersion (only image-upload advances it)', async () => {
    setBackgroundSettings({ kind: 'image', preset: null, imageVersion: 5 })
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { kind: 'gradient', preset: 'ocean' },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings).toEqual({ kind: 'gradient', preset: 'ocean', imageVersion: 5 })
    } finally {
      await app.close()
    }
  })

  it('PUT rejects an invalid kind/preset with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { kind: 'nebula', preset: null },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('PUT {kind:image} with no wallpaper uploaded → 400', async () => {
    // beforeEach already wiped wallpaper.* — this is the "none present" state.
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/background',
        payload: { kind: 'image', preset: null },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/no image uploaded/i)
    } finally {
      await app.close()
    }
  })
})

describe('PUT/GET /api/settings/background/image', () => {
  it('PUT with a valid PNG data URL sets kind:image and increments imageVersion; GET image serves it', async () => {
    setBackgroundSettings({ kind: 'solid', preset: null, imageVersion: null })
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/background/image',
        payload: { dataUrl: TINY_PNG_DATA_URL },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings).toEqual({ kind: 'image', preset: null, imageVersion: 1 })
      expect(backgroundSettings()).toEqual({ kind: 'image', preset: null, imageVersion: 1 })

      const getImg = await app.inject({ method: 'GET', url: '/api/settings/background/image' })
      expect(getImg.statusCode).toBe(200)
      expect(getImg.headers['content-type']).toBe('image/png')
    } finally {
      await app.close()
    }
  })

  it('a second upload increments imageVersion again and replaces the stored file', async () => {
    setBackgroundSettings({ kind: 'image', preset: null, imageVersion: 1 })
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/background/image',
        payload: { dataUrl: TINY_PNG_DATA_URL },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().settings.imageVersion).toBe(2)

      const files = await fs.readdir(wallpaperDir())
      expect(files.filter(f => f.startsWith('wallpaper.'))).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('PUT rejects an unsupported mime (gif) with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/background/image',
        payload: { dataUrl: `data:image/gif;base64,${TINY_PNG_B64}` },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('PUT rejects an oversize image (>8MB decoded) with 400', async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1024, 1).toString('base64')
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/background/image',
        payload: { dataUrl: `data:image/png;base64,${oversized}` },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/too large/i)
    } finally {
      await app.close()
    }
  })

  it('GET image with none uploaded → 404', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings/background/image' })
      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
