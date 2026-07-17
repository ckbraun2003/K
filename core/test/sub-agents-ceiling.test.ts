/**
 * C.3 (D-121) — sub-agent worker grants are ceiling-validated at the
 * `orchestrator` tier (WORKER_CEILING_TIER): workers run INSIDE an
 * orchestrator's authority, so a worker's resolved `{allowedTools,mcpServers,
 * skills}` may never exceed what the orchestrator tier itself grants.
 *
 * POST validates the resolved (post-clone-merge) grants before create.
 * PATCH fetches the CURRENT worker, merges the patch arrays over it, then
 * validates the MERGED result before update — so a patch that doesn't touch
 * allowedTools can't be blocked by an unrelated field change, and a patch
 * that DOES touch it is checked against the full merged set, not just the
 * patch's own (possibly empty) delta.
 *
 * Uses the REAL assertEffectiveGrants (agent-config/allowlists/orchestrator.json
 * is the real ceiling) — no mocking of authority.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const createdIds: string[] = []

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  for (const id of createdIds) db.prepare('DELETE FROM sub_agent_defs WHERE id = ?').run(id)
  await app.close()
})

describe('POST /api/sub-agents — ceiling validation (D-121)', () => {
  it('an in-ceiling worker (allowedTools: ["Read"]) creates fine (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-ok-${Date.now()}`, role: 'r', prompt: 'p', allowedTools: ['Read'] },
    })
    expect(res.statusCode).toBe(201)
    createdIds.push(res.json().id)
  })

  it('an above-ceiling worker (allowedTools: ["mcp__nonexistent"]) is rejected (400, "exceeds")', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-bad-${Date.now()}`, role: 'r', prompt: 'p', allowedTools: ['mcp__nonexistent'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/exceeds/)
  })

  it('a plain create with no tool/mcp/skill arrays (all default to []) always passes (empty is always within any ceiling)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-empty-${Date.now()}`, role: 'r', prompt: 'p' },
    })
    expect(res.statusCode).toBe(201)
    createdIds.push(res.json().id)
  })

  it('forking a K-native worker (cloneFrom) inherits its already-in-ceiling grants (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-fork-${Date.now()}`, cloneFrom: 'k:implementer' },
    })
    expect(res.statusCode).toBe(201)
    createdIds.push(res.json().id)
  })
})

describe('PATCH /api/sub-agents/:id — ceiling validation (D-121, merge-then-validate)', () => {
  it('patching allowedTools to an above-ceiling set is rejected (400); the row is left unchanged', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-patch-${Date.now()}`, role: 'r', prompt: 'p', allowedTools: ['Read'] },
    })).json()
    createdIds.push(created.id)

    const bad = await app.inject({
      method: 'PATCH', url: `/api/sub-agents/${created.id}`, headers: AUTH,
      payload: { allowedTools: ['mcp__nonexistent'] },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/exceeds/)

    const after = await app.inject({ method: 'GET', url: `/api/sub-agents/${created.id}`, headers: AUTH })
    expect(after.json().allowedTools).toEqual(['Read'])
  })

  it('a patch that does NOT touch allowedTools/mcpServers/skills still passes — merged against the CURRENT (already-valid) arrays, not an empty delta', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/sub-agents', headers: AUTH,
      payload: { name: `test-ceiling-noop-${Date.now()}`, role: 'r', prompt: 'p', allowedTools: ['Read'] },
    })).json()
    createdIds.push(created.id)

    const res = await app.inject({
      method: 'PATCH', url: `/api/sub-agents/${created.id}`, headers: AUTH,
      payload: { role: 'after', enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().allowedTools).toEqual(['Read'])
  })

  it('404s on an unknown operator id before any ceiling check runs', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sub-agents/no-such-id', headers: AUTH,
      payload: { allowedTools: ['Read'] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('403s on a K-native id — the read-only guard fires before/independent of the ceiling check', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sub-agents/k:implementer', headers: AUTH,
      payload: { allowedTools: ['Read'] },
    })
    expect(res.statusCode).toBe(403)
  })
})
