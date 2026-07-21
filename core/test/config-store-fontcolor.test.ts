/**
 * config-store — font-colour override (ui-adjustments Round 2). Mirrors
 * config-store-background.test.ts's pattern exactly: storage-layer contract
 * only (absent/default, round-trip, corrupt fallback). Route-level behavior
 * lives in settings-font-color.test.ts.
 *
 * Tests run against the vitest-isolated test DB (K_DATA_DIR is a temp dir, set
 * globally by vitest.config.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, configDb } from '../src/db.js'
import { fontColorSettings, setFontColorSettings, __resetConfigCache } from '../src/config-store.js'

const FC_KEY = 'ui.fontColor'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

describe('fontColorSettings — absent key', () => {
  it('returns DEFAULT_FONT_COLOR_SETTINGS ({ color: null }) when nothing is stored', () => {
    expect(fontColorSettings()).toEqual({ color: null })
  })
})

describe('setFontColorSettings / fontColorSettings — round-trip', () => {
  it('a valid hex color round-trips through set → get', () => {
    setFontColorSettings({ color: '#a1b2c3' })
    expect(fontColorSettings()).toEqual({ color: '#a1b2c3' })
  })

  it('null round-trips (clears back to the theme default)', () => {
    setFontColorSettings({ color: '#a1b2c3' })
    setFontColorSettings({ color: null })
    expect(fontColorSettings()).toEqual({ color: null })
  })
})

describe('fontColorSettings — corrupt stored value', () => {
  it('unparseable JSON falls back to DEFAULT_FONT_COLOR_SETTINGS', () => {
    configDb.set(FC_KEY, 'not valid json{')
    expect(fontColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON that fails schema validation (bad hex) falls back to default', () => {
    configDb.set(FC_KEY, JSON.stringify({ color: 'not-a-hex' }))
    expect(fontColorSettings()).toEqual({ color: null })
  })

  it('well-formed JSON with a 3-digit hex (unsupported shorthand) falls back to default', () => {
    configDb.set(FC_KEY, JSON.stringify({ color: '#abc' }))
    expect(fontColorSettings()).toEqual({ color: null })
  })
})
