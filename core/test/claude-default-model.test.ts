/**
 * Runtime Claude default model — persisted over app_config (P5.5).
 *
 * The Claude default model used to be a boot-time `const` read once at module
 * load in router.ts. It is now runtime-managed via a config-store getter/setter
 * (app_config key `claude.model`), seeded from CLAUDE_MODEL, hot-swappable with
 * no restart. Mirrors the ollama/voice config pattern + its tests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import {
  claudeDefaultModel,
  setClaudeDefaultModel,
  __resetConfigCache,
} from '../src/config-store.js'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  delete process.env.CLAUDE_MODEL
})

describe('claudeDefaultModel — seeds from env', () => {
  it('returns CLAUDE_MODEL env when app_config is empty', () => {
    process.env.CLAUDE_MODEL = 'claude-opus-4-8'
    __resetConfigCache()
    expect(claudeDefaultModel()).toBe('claude-opus-4-8')
    delete process.env.CLAUDE_MODEL
  })

  it('returns the sonnet default when env is absent', () => {
    delete process.env.CLAUDE_MODEL
    __resetConfigCache()
    expect(claudeDefaultModel()).toBe('claude-sonnet-4-6')
  })
})

describe('set → getter reads new value (cache path)', () => {
  it('setClaudeDefaultModel → claudeDefaultModel() returns new value', () => {
    setClaudeDefaultModel('claude-haiku-4-5-20251001')
    expect(claudeDefaultModel()).toBe('claude-haiku-4-5-20251001')
  })
})

describe('set persists to DB (round-trip through cache reset)', () => {
  it('setClaudeDefaultModel persists — cache-reset re-reads from DB', () => {
    setClaudeDefaultModel('claude-fable-5')
    __resetConfigCache()
    expect(claudeDefaultModel()).toBe('claude-fable-5')
  })

  it('a runtime set OVERRIDES the env seed after a cache reset', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6'
    setClaudeDefaultModel('claude-opus-4-8')
    __resetConfigCache()
    expect(claudeDefaultModel()).toBe('claude-opus-4-8')
    delete process.env.CLAUDE_MODEL
  })
})
