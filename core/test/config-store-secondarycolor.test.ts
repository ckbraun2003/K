/**
 * config-store — secondary accent-colour override (ui-adjustments Round 4).
 * Mirrors config-store-fontcolor.test.ts's pattern exactly: storage-layer
 * contract only (absent/default, round-trip, corrupt fallback). Route-level
 * behavior lives in settings-secondary-color.test.ts.
 *
 * Tests run against the vitest-isolated test DB (K_DATA_DIR is a temp dir, set
 * globally by vitest.config.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, configDb } from '../src/db.js'
import { secondaryColorSettings, setSecondaryColorSettings, __resetConfigCache } from '../src/config-store.js'

const SECONDARY_KEY = 'ui.secondaryColor'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

describe('secondaryColorSettings — absent key', () => {
  it('returns DEFAULT_SECONDARY_COLOR_SETTINGS ({ color: null }) when nothing is stored', () => {
    expect(secondaryColorSettings()).toEqual({ color: null })
  })
})

describe('setSecondaryColorSettings / secondaryColorSettings — round-trip', () => {
  it('a valid hex color round-trips through set → get', () => {
    setSecondaryColorSettings({ color: '#a1b2c3' })
    expect(secondaryColorSettings()).toEqual({ color: '#a1b2c3' })
  })

  it('null round-trips (clears back to the theme default)', () => {
    setSecondaryColorSettings({ color: '#a1b2c3' })
    setSecondaryColorSettings({ color: null })
    expect(secondaryColorSettings()).toEqual({ color: null })
  })
})

describe('secondaryColorSettings — corrupt stored value', () => {
  it('unparseable JSON falls back to DEFAULT_SECONDARY_COLOR_SETTINGS', () => {
    configDb.set(SECONDARY_KEY, 'not valid json{')
    expect(secondaryColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON that fails schema validation (bad hex) falls back to default', () => {
    configDb.set(SECONDARY_KEY, JSON.stringify({ color: 'not-a-hex' }))
    expect(secondaryColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON with a 3-digit hex (unsupported shorthand) falls back to default', () => {
    configDb.set(SECONDARY_KEY, JSON.stringify({ color: '#abc' }))
    expect(secondaryColorSettings()).toEqual({ color: null })
  })
})
