/**
 * Unified available-models aggregate (Usability & Access Phase 2.6, Lane C
 * Task C.1) — Claude KNOWN_MODELS ∪ installed Ollama models, degrading
 * gracefully (empty local set, localDegraded:true) when Ollama is unreachable.
 * `resolveAvailableModels`/`availableModelIds` are pure unit-level (mock
 * listInstalled); `GET /api/models/available` is covered by an in-process
 * Fastify inject at the bottom of this file.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('../src/ollama-client.js', () => ({
  listInstalled: vi.fn(),
  OllamaNetworkError: class extends Error {},
}))

import { listInstalled } from '../src/ollama-client.js'
import { resolveAvailableModels, availableModelIds } from '../src/models.js'

describe('resolveAvailableModels', () => {
  it('merges claude + local; degrades gracefully on Ollama failure', async () => {
    ;(listInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { name: 'llama3.2:3b', sizeBytes: 1 },
    ])
    const ok = await resolveAvailableModels()
    expect(ok.localDegraded).toBe(false)
    expect(ok.models.some(m => m.id === 'claude-opus-4-8' && m.kind === 'claude')).toBe(true)
    expect(ok.models.some(m => m.id === 'llama3.2:3b' && m.kind === 'local')).toBe(true)

    ;(listInstalled as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    const deg = await resolveAvailableModels()
    expect(deg.localDegraded).toBe(true)
    expect(deg.models.every(m => m.kind === 'claude')).toBe(true)
  })
})

describe('availableModelIds', () => {
  it('returns the set of every model id in the response', async () => {
    ;(listInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { name: 'llama3.2:3b', sizeBytes: 1 },
    ])
    const resp = await resolveAvailableModels()
    const ids = availableModelIds(resp)
    expect(ids.has('claude-opus-4-8')).toBe(true)
    expect(ids.has('llama3.2:3b')).toBe(true)
    expect(ids.has('bogus:1b')).toBe(false)
  })
})

describe('GET /api/models/available', () => {
  const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
  const AUTH = { authorization: `Bearer ${TOKEN}` }
  let app: import('fastify').FastifyInstance

  beforeAll(async () => {
    process.env.K_SKIP_BOOTSTRAP = '1'
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('serves the unified list over HTTP', async () => {
    ;(listInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    const res = await app.inject({ method: 'GET', url: '/api/models/available', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { models: { id: string; kind: string }[]; localDegraded: boolean }
    expect(body.models.some(m => m.id === 'claude-sonnet-4-6')).toBe(true)
    expect(typeof body.localDegraded).toBe('boolean')
  })
})
