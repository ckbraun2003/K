/**
 * config-store — primary accent-colour override (ui-adjustments Round 4).
 * Mirrors config-store-fontcolor.test.ts's pattern exactly: storage-layer
 * contract only (absent/default, round-trip, corrupt fallback). Route-level
 * behavior lives in settings-primary-color.test.ts.
 *
 * Tests run against the vitest-isolated test DB (K_DATA_DIR is a temp dir, set
 * globally by vitest.config.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, configDb } from '../src/db.js'
import { primaryColorSettings, setPrimaryColorSettings, __resetConfigCache } from '../src/config-store.js'

const PRIMARY_KEY = 'ui.primaryColor'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

describe('primaryColorSettings — absent key', () => {
  it('returns DEFAULT_PRIMARY_COLOR_SETTINGS ({ color: null }) when nothing is stored', () => {
    expect(primaryColorSettings()).toEqual({ color: null })
  })
})

describe('setPrimaryColorSettings / primaryColorSettings — round-trip', () => {
  it('a valid hex color round-trips through set → get', () => {
    setPrimaryColorSettings({ color: '#a1b2c3' })
    expect(primaryColorSettings()).toEqual({ color: '#a1b2c3' })
  })

  it('null round-trips (clears back to the theme default)', () => {
    setPrimaryColorSettings({ color: '#a1b2c3' })
    setPrimaryColorSettings({ color: null })
    expect(primaryColorSettings()).toEqual({ color: null })
  })
})

describe('primaryColorSettings — corrupt stored value', () => {
  it('unparseable JSON falls back to DEFAULT_PRIMARY_COLOR_SETTINGS', () => {
    configDb.set(PRIMARY_KEY, 'not valid json{')
    expect(primaryColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON that fails schema validation (bad hex) falls back to default', () => {
    configDb.set(PRIMARY_KEY, JSON.stringify({ color: 'not-a-hex' }))
    expect(primaryColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON with a 3-digit hex (unsupported shorthand) falls back to default', () => {
    configDb.set(PRIMARY_KEY, JSON.stringify({ color: '#abc' }))
    expect(primaryColorSettings()).toEqual({ color: null })
  })
})
