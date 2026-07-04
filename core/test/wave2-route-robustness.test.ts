/**
 * Wave 2 — core API robustness (bug-fix campaign 2026-07-03).
 *
 * Drives the real Fastify app (buildApp) with app.inject over the durable DB (shared
 * K_DATA_DIR singleton, serial fork). Covers the route-level findings:
 *   F-017  POST /api/runs/:id/kill on an unknown id → 404 (was 200 { killed:false })
 *   F-018  GET  /api/runs/:id/events on an unknown id → 404; real run w/ none → 200 []
 *   F-019  DELETE /api/k/work-items/:id lifecycle + durable-only scope guard
 *   F-020  GET /api/profiles/:id inspects K + Chief read-only; their PATCH stays rejected
 *   F-021  a converted route emits the standard { error, details } envelope
 *   F-022  PATCH /api/skills/:id validates the body BEFORE existence (bad body → 400)
 *   F-024  PATCH /api/orchestrators/:id naming tier/charter as immutable, profile unchanged
 *
 * supervisor is NOT mocked — every asserted path is a guard that returns before any
 * process spawn (unknown-id 404s, validation 400s), so no real agent is launched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, workItemsDb } from '../src/db.js'
import { seedProfiles, getProfile } from '../src/profiles.js'
import type { AgentProfile, WorkItem } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const TITLE_TAG = `wave2-${uuid().slice(0, 8)}`
const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

let app: FastifyInstance
const emptyRunId = uuid()
const runScopedItemId = uuid()

/** Insert a real run row (the guard reads the DB before any supervisor call). */
function seedRun(id: string, status: string): void {
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, 'p', '/tmp', status, Date.now())
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  seedProfiles()
  seedRun(emptyRunId, 'done') // a real run with zero events (F-018 200 [] path)
  const now = Date.now()
  // A run-scoped kstore ticket — must be UNREACHABLE from the durable DELETE (F-019 guard).
  workItemsDb.insertWorkItem.run({
    id: runScopedItemId, runId: null, title: `${TITLE_TAG} run-scoped`, body: null,
    status: 'open', scope: 'run', createdAt: now, updatedAt: now,
  })
})

afterAll(async () => {
  db.prepare(`DELETE FROM work_items WHERE title LIKE ?`).run(`${TITLE_TAG}%`)
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(emptyRunId)
  for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  await app.close()
})

describe('F-017 — POST /api/runs/:id/kill existence guard', () => {
  it('404 for an unknown run id (was a misleading 200 { killed:false })', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${uuid()}/kill`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('200 { killed } for a real run (exists but no live process)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${emptyRunId}/kill`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('killed')
  })
})

describe('F-018 — GET /api/runs/:id/events existence guard', () => {
  it('404 for an unknown run id (was 200 [], indistinguishable from "no events")', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${uuid()}/events`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('200 [] for a real run that has no events', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${emptyRunId}/events`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('F-019 — DELETE /api/k/work-items/:id', () => {
  it('create → delete (204) → re-delete (404)', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/k/work-items', headers: AUTH,
      payload: { title: `${TITLE_TAG} delete-me` },
    })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as WorkItem).id

    const del = await app.inject({ method: 'DELETE', url: `/api/k/work-items/${id}`, headers: AUTH })
    expect(del.statusCode).toBe(204)

    // Gone: it no longer lists, and a second delete 404s.
    const redel = await app.inject({ method: 'DELETE', url: `/api/k/work-items/${id}`, headers: AUTH })
    expect(redel.statusCode).toBe(404)
    const patch = await app.inject({
      method: 'PATCH', url: `/api/k/work-items/${id}`, headers: AUTH, payload: { status: 'done' },
    })
    expect(patch.statusCode).toBe(404)
  })

  it('a run-scoped kstore ticket is UNREACHABLE (durable-only scope guard) → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/k/work-items/${runScopedItemId}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    // The ticket still exists (never deleted through the durable surface).
    expect(workItemsDb.getWorkItem.get(runScopedItemId)).toBeTruthy()
  })

  it('401 without the Bearer header (same auth as the other work-item routes)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/k/work-items/${uuid()}` })
    expect(res.statusCode).toBe(401)
  })
})

describe('F-020 — read-only profile inspection', () => {
  it('GET /api/profiles/:id returns the K and Chief top-tier profiles', async () => {
    const k = await app.inject({ method: 'GET', url: '/api/profiles/k-secretary', headers: AUTH })
    expect(k.statusCode).toBe(200)
    expect((k.json() as AgentProfile).tier).toBe('secretary')

    const chief = await app.inject({ method: 'GET', url: '/api/profiles/chief', headers: AUTH })
    expect(chief.statusCode).toBe(200)
    expect((chief.json() as AgentProfile).tier).toBe('chief')
  })

  it('GET /api/profiles lists every durable profile; unknown id → 404', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/profiles', headers: AUTH })
    expect(list.statusCode).toBe(200)
    const ids = (list.json() as AgentProfile[]).map(p => p.id)
    expect(ids).toEqual(expect.arrayContaining(['k-secretary', 'chief']))

    const miss = await app.inject({ method: 'GET', url: `/api/profiles/${uuid()}`, headers: AUTH })
    expect(miss.statusCode).toBe(404)
  })

  it('opens NO write path — the authority PATCH cannot touch K/Chief at all', async () => {
    for (const id of ['k-secretary', 'chief']) {
      // A well-formed authority patch (valid body) is still rejected because K/Chief are not
      // leads — so there is no PATCH path to them; the inspection route is read-only.
      const valid = await app.inject({
        method: 'PATCH', url: `/api/orchestrators/${id}`, headers: AUTH, payload: { skills: [] },
      })
      expect(valid.statusCode).toBe(404)
      // And a tier/charter move is rejected at validation (immutable) regardless of target.
      const tierMove = await app.inject({
        method: 'PATCH', url: `/api/orchestrators/${id}`, headers: AUTH, payload: { tier: 'orchestrator' },
      })
      expect(tierMove.statusCode).toBe(400)
    }
    // Their tier is untouched.
    expect(getProfile('k-secretary')!.tier).toBe('secretary')
    expect(getProfile('chief')!.tier).toBe('chief')
  })
})

describe('F-021 — standard error envelope on a converted route', () => {
  it('POST /api/runs with a bad body → { error: "validation failed", details }', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string; details?: unknown }
    expect(typeof body.error).toBe('string') // never an object (would render "[object Object]" in the UI)
    expect(body.error).toBe('validation failed')
    expect(body.details).toBeDefined()
  })
})

describe('F-022 — PATCH /api/skills/:id validates the body before existence', () => {
  it('unknown id + bad body → 400 (validation first), not 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${uuid()}`, headers: AUTH, payload: { bogus: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('unknown id + VALID body → 404 (existence after a clean body)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${uuid()}`, headers: AUTH, payload: { enabled: false },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('F-024 — PATCH /api/orchestrators/:id names immutable fields', () => {
  it('tier/charter rejection names the field + why, and the profile is UNCHANGED', async () => {
    const before = getProfile('lead-backend')!
    for (const payload of [{ tier: 'chief' }, { charter: 'secretary' }]) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/orchestrators/lead-backend', headers: AUTH, payload,
      })
      expect(res.statusCode).toBe(400)
      const err = (res.json() as { error: string }).error
      expect(err).toMatch(/tier|charter/)
      expect(err).toMatch(/immutable/)
    }
    const after = getProfile('lead-backend')!
    expect(after.tier).toBe(before.tier)
    expect(after.charter).toBe(before.charter)
  })
})
