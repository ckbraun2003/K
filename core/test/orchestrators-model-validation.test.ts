/**
 * Model + ceiling validation on the org PATCH surfaces (B1).
 *
 * PATCH /api/orchestrators/:id and PATCH /api/org-default now:
 *   - gate defaultModel through isKnownModel (same gate as PUT /api/claude/model);
 *     garbage → 400 'unknown model',
 *   - accept an explicit null to CLEAR the override back to the runtime default,
 *   - map the new assertTierCeiling guard ("exceeds the … tier ceiling") to 400.
 * GET /api/orchestrators/:id surfaces effectiveModel — which model the next
 * dispatch will ACTUALLY use (override vs runtime-default).
 *
 * Mirrors orchestrators-route.test.ts's setup: the real Fastify app in-process
 * (buildApp), Bearer auth, self-seeded durable roster, full cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'
import { seedProfiles, getProfile } from '../src/profiles.js'
import { claudeDefaultModel } from '../src/config-store.js'
import type { AgentProfile, ChiefOrgLead } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  seedProfiles()
})

afterAll(async () => {
  try {
    // Removing the seed rows restores the shared DB to its pre-suite state (the
    // org-default row included — no lingering model override).
    for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  } catch { /* ignore */ }
  await app.close()
})

const patchLead = (payload: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH, payload: payload as object })
const getLead = () =>
  app.inject({ method: 'GET', url: '/api/orchestrators/lead-frontend', headers: AUTH })
const patchOrgDefault = (payload: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/org-default', headers: AUTH, payload: payload as object })

describe('PATCH /api/orchestrators/:id — defaultModel validation', () => {
  it('rejects a garbage model id (400 unknown model), row unchanged', async () => {
    const before = getProfile('lead-frontend')!.defaultModel
    const res = await patchLead({ defaultModel: 'garbage' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('unknown model')
    expect(getProfile('lead-frontend')!.defaultModel).toBe(before)
  })

  it('accepts a known model id → the row carries the override; effectiveModel says so', async () => {
    const res = await patchLead({ defaultModel: 'claude-opus-4-8' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentProfile).defaultModel).toBe('claude-opus-4-8')

    const detail = (await getLead()).json() as ChiefOrgLead
    expect(detail.effectiveModel).toEqual({ model: 'claude-opus-4-8', source: 'override' })
  })

  it('null CLEARS the override → effectiveModel falls back to the runtime default', async () => {
    const res = await patchLead({ defaultModel: null })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentProfile).defaultModel).toBeNull()

    const detail = (await getLead()).json() as ChiefOrgLead
    expect(detail.effectiveModel!.source).toBe('runtime-default')
    expect(detail.effectiveModel!.model).toBe(claudeDefaultModel())
  })

  it("'' clears the override exactly like null (it is the storage no-override sentinel)", async () => {
    // Set an override first so the clear is observable.
    expect((await patchLead({ defaultModel: 'claude-opus-4-8' })).statusCode).toBe(200)

    const res = await patchLead({ defaultModel: '' })
    expect(res.statusCode).toBe(200) // NOT a 400 — '' normalizes to the clear-sentinel
    expect((res.json() as AgentProfile).defaultModel).toBeNull()

    const detail = (await getLead()).json() as ChiefOrgLead
    expect(detail.effectiveModel!.source).toBe('runtime-default')
    expect(detail.effectiveModel!.model).toBe(claudeDefaultModel())
  })

  it('an above-ceiling allowedTools patch is a 400 (tier ceiling), row unchanged', async () => {
    const before = getProfile('lead-frontend')!.allowedTools
    // Two distinct above-ceiling shapes: the dead `Agent` token (never a valid
    // grant at ANY tier — D-032) and a tool the orchestrator allowlist simply
    // doesn't carry. `Bash` alongside is legitimate at this tier — the 400 is
    // triggered by the above-ceiling entry, not the whole list.
    for (const bad of ['Agent', 'NotARealTool']) {
      const res = await patchLead({ allowedTools: ['Bash', bad] })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toMatch(/tier ceiling/)
    }
    expect(getProfile('lead-frontend')!.allowedTools).toEqual(before)
  })
})

describe('PATCH /api/org-default — defaultModel validation', () => {
  it('rejects a garbage model id (400 unknown model)', async () => {
    const res = await patchOrgDefault({ defaultModel: 'garbage' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('unknown model')
  })

  it('accepts a known model id, then null clears it back to the runtime default', async () => {
    const set = await patchOrgDefault({ defaultModel: 'claude-opus-4-8' })
    expect(set.statusCode).toBe(200)
    expect((set.json() as AgentProfile).defaultModel).toBe('claude-opus-4-8')

    // Restore the seed-equivalent state (no override) — and prove null round-trips.
    const clear = await patchOrgDefault({ defaultModel: null })
    expect(clear.statusCode).toBe(200)
    expect((clear.json() as AgentProfile).defaultModel).toBeNull()
    expect(getProfile('default-orchestrator')!.defaultModel).toBeNull()
  })

  it("'' clears the override exactly like null (storage no-override sentinel)", async () => {
    expect((await patchOrgDefault({ defaultModel: 'claude-opus-4-8' })).statusCode).toBe(200)

    const res = await patchOrgDefault({ defaultModel: '' })
    expect(res.statusCode).toBe(200) // NOT a 400 — '' normalizes to the clear-sentinel
    expect((res.json() as AgentProfile).defaultModel).toBeNull()
    expect(getProfile('default-orchestrator')!.defaultModel).toBeNull() // seed-equivalent state restored
  })
})
