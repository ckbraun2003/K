/**
 * C.2 — per-agent default-model validation is relaxed from the static
 * `isKnownModel` (Claude-only) gate to membership in the unified available-
 * models set (Claude KNOWN_MODELS ∪ installed Ollama), on the three per-agent
 * default-model surfaces: PATCH /api/orchestrators/:id, PATCH /api/org-default,
 * and POST/PATCH /api/sub-agents. `resolveAvailableModels` is mocked here to
 * include a fake local id so the test doesn't depend on a real Ollama daemon;
 * `availableModelIds` stays the real implementation.
 *
 * `core/test/orchestrators-model-validation.test.ts` is the pre-existing
 * regression covering the garbage-id / null / '' behavior — this file only
 * adds coverage for the NEW "a local model id is now accepted" behavior.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../src/models.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/models.js')>()
  return {
    ...actual,
    resolveAvailableModels: vi.fn(async () => ({
      models: [
        { id: 'claude-opus-4-8', label: 'Opus 4.8', kind: 'claude', contextWindow: 200_000 },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', kind: 'claude', contextWindow: 200_000 },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', kind: 'claude', contextWindow: 200_000 },
        { id: 'claude-fable-5', label: 'Fable 5', kind: 'claude', contextWindow: 200_000 },
        { id: 'llama3.2:3b', label: 'llama3.2:3b', kind: 'local' as const },
      ],
      localDegraded: false,
    })),
  }
})

import { db } from '../src/db.js'
import { seedProfiles } from '../src/profiles.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

let app: FastifyInstance
const createdSubAgentIds: string[] = []

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  seedProfiles()
})

afterAll(async () => {
  try {
    for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  } catch { /* ignore */ }
  for (const id of createdSubAgentIds) db.prepare('DELETE FROM sub_agent_defs WHERE id = ?').run(id)
  await app.close()
})

describe('PATCH /api/orchestrators/:id — accepts a local model id', () => {
  it('a fake local id is accepted (200); a truly unknown id is still 400', async () => {
    const ok = await app.inject({
      method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH,
      payload: { defaultModel: 'llama3.2:3b' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().defaultModel).toBe('llama3.2:3b')

    const bad = await app.inject({
      method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH,
      payload: { defaultModel: 'bogus:1b' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('unknown model')
  })
})

describe('PATCH /api/org-default — accepts a local model id', () => {
  it('a fake local id is accepted (200); a truly unknown id is still 400', async () => {
    const ok = await app.inject({
      method: 'PATCH', url: '/api/org-default', headers: AUTH,
      payload: { defaultModel: 'llama3.2:3b' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().defaultModel).toBe('llama3.2:3b')

    const bad = await app.inject({
      method: 'PATCH', url: '/api/org-default', headers: AUTH,
      payload: { defaultModel: 'bogus:1b' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('unknown model')

    // restore seed-equivalent state
    await app.inject({ method: 'PATCH', url: '/api/org-default', headers: AUTH, payload: { defaultModel: null } })
  })
})

describe('POST /api/sub-agents — accepts a local model id', () => {
  it('a fake local id is accepted (201); a truly unknown id is 400', async () => {
    const ok = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-local-model-${Date.now()}`, role: 'r', prompt: 'p', model: 'llama3.2:3b' },
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().model).toBe('llama3.2:3b')
    createdSubAgentIds.push(ok.json().id)

    const bad = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-bad-model-${Date.now()}`, role: 'r', prompt: 'p', model: 'bogus:1b' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('unknown model')
  })
})

describe('PATCH /api/sub-agents/:id — accepts a local model id', () => {
  it('a fake local id is accepted (200); a truly unknown id is 400', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-patch-model-${Date.now()}`, role: 'r', prompt: 'p' },
    })).json()
    createdSubAgentIds.push(created.id)

    const ok = await app.inject({
      method: 'PATCH', url: `/api/sub-agents/${created.id}`, headers: AUTH,
      payload: { model: 'llama3.2:3b' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().model).toBe('llama3.2:3b')

    const bad = await app.inject({
      method: 'PATCH', url: `/api/sub-agents/${created.id}`, headers: AUTH,
      payload: { model: 'bogus:1b' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('unknown model')
  })
})
