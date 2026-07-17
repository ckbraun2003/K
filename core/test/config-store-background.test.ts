/**
 * config-store — background settings (usability-access B.3 → wallpaper settings
 * model). Covers the storage-layer contract only: legacy bare-variant → settings
 * migration, JSON round-trip, and corrupt-value fallback. Route-level behavior
 * (GET/PUT/image upload+serve) lives in settings-background.test.ts.
 *
 * Tests run against the vitest-isolated test DB (K_DATA_DIR is a temp dir, set
 * globally by vitest.config.ts) — mirrors config-store.test.ts's pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, configDb } from '../src/db.js'
import { backgroundSettings, setBackgroundSettings, __resetConfigCache } from '../src/config-store.js'

const BG_KEY = 'ui.background'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

describe('backgroundSettings — absent key', () => {
  it('returns DEFAULT_BACKGROUND_SETTINGS when nothing is stored', () => {
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null })
  })
})

describe('backgroundSettings — legacy bare-variant migration', () => {
  it.each(['galaxy', 'blobs', 'solid'])('legacy %s maps to solid', legacy => {
    configDb.set(BG_KEY, legacy)
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null })
  })

  it('legacy aurora maps to gradient/aurora', () => {
    configDb.set(BG_KEY, 'aurora')
    expect(backgroundSettings()).toEqual({ kind: 'gradient', preset: 'aurora', imageVersion: null })
  })
})

describe('setBackgroundSettings / backgroundSettings — round-trip', () => {
  it('a valid settings object round-trips through set → get', () => {
    setBackgroundSettings({ kind: 'gradient', preset: 'ember', imageVersion: null })
    expect(backgroundSettings()).toEqual({ kind: 'gradient', preset: 'ember', imageVersion: null })
  })

  it('round-trips an image kind with a numeric imageVersion', () => {
    setBackgroundSettings({ kind: 'image', preset: null, imageVersion: 3 })
    expect(backgroundSettings()).toEqual({ kind: 'image', preset: null, imageVersion: 3 })
  })
})

describe('backgroundSettings — corrupt stored value', () => {
  it('unparseable JSON falls back to DEFAULT_BACKGROUND_SETTINGS', () => {
    configDb.set(BG_KEY, 'not valid json{')
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null })
  })

  it('well-formed JSON that fails schema validation falls back to DEFAULT_BACKGROUND_SETTINGS', () => {
    configDb.set(BG_KEY, JSON.stringify({ kind: 'nebula', preset: null, imageVersion: null }))
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null })
  })
})
