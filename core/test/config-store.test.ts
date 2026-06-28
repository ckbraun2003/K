/**
 * config-store — persisted runtime config over app_config.
 *
 * Tests run against the vitest-isolated test DB (K_DATA_DIR is a temp dir).
 * Each test resets both the in-memory cache and the DB rows so tests are order-
 * independent.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import {
  ollamaEnabled,
  ollamaBaseUrl,
  activeOllamaModel,
  setOllamaEnabled,
  setOllamaBaseUrl,
  setActiveOllamaModel,
  __resetConfigCache,
} from '../src/config-store.js'

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  // Clear seed env so a value leaked by a failed assertion can't pollute the next test.
  delete process.env.ENABLE_OLLAMA
  delete process.env.OLLAMA_BASE_URL
  delete process.env.OLLAMA_MODEL
})

describe('ollamaEnabled — seeds from env', () => {
  it('returns true when ENABLE_OLLAMA=true and app_config is empty', () => {
    process.env.ENABLE_OLLAMA = 'true'
    expect(ollamaEnabled()).toBe(true)
    delete process.env.ENABLE_OLLAMA
  })

  it('returns false when ENABLE_OLLAMA is absent', () => {
    delete process.env.ENABLE_OLLAMA
    expect(ollamaEnabled()).toBe(false)
  })
})

describe('ollamaBaseUrl — seeds from env', () => {
  it('returns OLLAMA_BASE_URL env when app_config is empty', () => {
    process.env.OLLAMA_BASE_URL = 'http://my-ollama:11434'
    __resetConfigCache()
    expect(ollamaBaseUrl()).toBe('http://my-ollama:11434')
    delete process.env.OLLAMA_BASE_URL
  })

  it('returns the default when env is absent', () => {
    delete process.env.OLLAMA_BASE_URL
    __resetConfigCache()
    expect(ollamaBaseUrl()).toBe('http://localhost:11434')
  })
})

describe('activeOllamaModel — seeds from env', () => {
  it('returns OLLAMA_MODEL env when app_config is empty', () => {
    process.env.OLLAMA_MODEL = 'mistral'
    __resetConfigCache()
    expect(activeOllamaModel()).toBe('mistral')
    delete process.env.OLLAMA_MODEL
  })

  it('returns the default when env is absent', () => {
    delete process.env.OLLAMA_MODEL
    __resetConfigCache()
    expect(activeOllamaModel()).toBe('llama3.2')
  })
})

describe('set* → getter reads new value (cache path)', () => {
  it('setOllamaEnabled(true) → ollamaEnabled() returns true', () => {
    setOllamaEnabled(true)
    expect(ollamaEnabled()).toBe(true)
  })

  it('setOllamaEnabled(false) → ollamaEnabled() returns false', () => {
    setOllamaEnabled(false)
    expect(ollamaEnabled()).toBe(false)
  })

  it('setOllamaBaseUrl → ollamaBaseUrl() returns new value', () => {
    setOllamaBaseUrl('http://other:11434')
    expect(ollamaBaseUrl()).toBe('http://other:11434')
  })

  it('setActiveOllamaModel → activeOllamaModel() returns new value', () => {
    setActiveOllamaModel('phi3')
    expect(activeOllamaModel()).toBe('phi3')
  })
})

describe('set* persists to DB (round-trip through cache reset)', () => {
  it('setOllamaEnabled persists — cache-reset re-reads from DB', () => {
    setOllamaEnabled(true)
    __resetConfigCache()
    expect(ollamaEnabled()).toBe(true)
  })

  it('setOllamaEnabled false persists', () => {
    setOllamaEnabled(false)
    __resetConfigCache()
    expect(ollamaEnabled()).toBe(false)
  })

  it('setOllamaBaseUrl persists', () => {
    setOllamaBaseUrl('http://persisted:11434')
    __resetConfigCache()
    expect(ollamaBaseUrl()).toBe('http://persisted:11434')
  })

  it('setActiveOllamaModel persists', () => {
    setActiveOllamaModel('gemma2')
    __resetConfigCache()
    expect(activeOllamaModel()).toBe('gemma2')
  })
})

describe('bool round-trips', () => {
  it('true → set → reset → true', () => {
    setOllamaEnabled(true)
    __resetConfigCache()
    expect(ollamaEnabled()).toBe(true)
  })

  it('false → set → reset → false', () => {
    setOllamaEnabled(false)
    __resetConfigCache()
    expect(ollamaEnabled()).toBe(false)
  })

  it('set(true) then set(false) → false wins (UPSERT)', () => {
    setOllamaEnabled(true)
    setOllamaEnabled(false)
    __resetConfigCache()
    expect(ollamaEnabled()).toBe(false)
  })
})
