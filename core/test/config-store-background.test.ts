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
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })
})

describe('backgroundSettings — legacy bare-variant migration', () => {
  it.each(['galaxy', 'blobs', 'solid'])('legacy %s maps to solid', legacy => {
    configDb.set(BG_KEY, legacy)
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })

  // ui-adjustments Round 4 drops the gradient backdrop from the UI — legacy
  // 'aurora' now maps to solid (like the other legacy variants) rather than a
  // now-dead gradient kind.
  it('legacy aurora maps to solid (gradient dropped)', () => {
    configDb.set(BG_KEY, 'aurora')
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })
})

describe('setBackgroundSettings / backgroundSettings — round-trip', () => {
  it('a valid settings object round-trips through set → get', () => {
    setBackgroundSettings({ kind: 'gradient', preset: 'ember', imageVersion: null, solidColor: null })
    expect(backgroundSettings()).toEqual({ kind: 'gradient', preset: 'ember', imageVersion: null, solidColor: null })
  })

  it('round-trips an image kind with a numeric imageVersion', () => {
    setBackgroundSettings({ kind: 'image', preset: null, imageVersion: 3, solidColor: null })
    expect(backgroundSettings()).toEqual({ kind: 'image', preset: null, imageVersion: 3, solidColor: null })
  })

  it('round-trips a solid kind with a solidColor override', () => {
    setBackgroundSettings({ kind: 'solid', preset: null, imageVersion: null, solidColor: '#334455' })
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: '#334455' })
  })
})

describe('backgroundSettings — corrupt stored value', () => {
  it('unparseable JSON falls back to DEFAULT_BACKGROUND_SETTINGS', () => {
    configDb.set(BG_KEY, 'not valid json{')
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })

  it('well-formed JSON that fails schema validation falls back to DEFAULT_BACKGROUND_SETTINGS', () => {
    configDb.set(BG_KEY, JSON.stringify({ kind: 'nebula', preset: null, imageVersion: null }))
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })

  it('a bad solidColor (invalid hex) fails schema validation and falls back to default', () => {
    configDb.set(BG_KEY, JSON.stringify({ kind: 'solid', preset: null, imageVersion: null, solidColor: 'not-a-hex' }))
    expect(backgroundSettings()).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
  })
})
