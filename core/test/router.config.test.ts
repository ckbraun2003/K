/**
 * router.config — route() reads the runtime config store, not boot-time env.
 *
 * Uses the injected deps mechanism (deps.ollamaReachable) so no network is
 * touched. The store is driven via setActiveOllamaModel / setOllamaEnabled.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { route } from '../src/router.js'
import {
  setOllamaEnabled,
  setOllamaBaseUrl,
  setActiveOllamaModel,
  __resetConfigCache,
} from '../src/config-store.js'

const TASK = { prompt: 'test task' }

function clearConfigTable() {
  db.prepare(`DELETE FROM app_config`).run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  delete process.env.ENABLE_OLLAMA
  delete process.env.OLLAMA_MODEL
  delete process.env.OLLAMA_BASE_URL
})

describe('route() reads active model from the config store', () => {
  it('returns the store model when ollama is enabled + reachable', () => {
    setOllamaEnabled(true)
    setActiveOllamaModel('phi3')
    const r = route({ ...TASK, preferLocal: true }, { ollamaReachable: true })
    expect(r.provider).toBe('ollama')
    expect(r.model).toBe('phi3')
  })

  it('reflects a runtime model change without restart', () => {
    setOllamaEnabled(true)
    setActiveOllamaModel('llama3.2')
    const r1 = route({ ...TASK, preferLocal: true }, { ollamaReachable: true })
    expect(r1.model).toBe('llama3.2')

    setActiveOllamaModel('mistral')
    const r2 = route({ ...TASK, preferLocal: true }, { ollamaReachable: true })
    expect(r2.model).toBe('mistral')
  })

  it('uses the store baseUrl in the result', () => {
    setOllamaEnabled(true)
    setOllamaBaseUrl('http://custom:11434')
    const r = route({ ...TASK, preferLocal: true }, { ollamaReachable: true })
    expect(r.provider).toBe('ollama')
    expect(r.baseUrl).toBe('http://custom:11434')
  })
})

describe('route() graceful degradation via store', () => {
  it('routes to claude when store has ollama disabled', () => {
    setOllamaEnabled(false)
    const r = route({ ...TASK, preferLocal: true }, { ollamaReachable: true })
    expect(r.provider).toBe('claude')
  })

  it('routes to claude when deps.ollamaReachable is false (even if store enables)', () => {
    setOllamaEnabled(true)
    setActiveOllamaModel('phi3')
    const r = route({ ...TASK, preferLocal: true }, { ollamaReachable: false })
    expect(r.provider).toBe('claude')
  })

  it('deps.enableOllama still overrides the store', () => {
    setOllamaEnabled(false)
    const r = route({ ...TASK, preferLocal: true }, { enableOllama: true, ollamaReachable: true })
    // deps.enableOllama: true overrides the store's false
    expect(r.provider).toBe('ollama')
  })
})
