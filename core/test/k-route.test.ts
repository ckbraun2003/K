/**
 * k routes — POST /api/k/ask + GET /api/k/thread (P5.1c, D-023).
 *
 * Builds the real Fastify app in-process (buildApp) and drives it with app.inject —
 * same bootstrap as app-routes.test.ts (K_SKIP_BOOTSTRAP set before importing index).
 * The supervisor is mocked so askK's fresh dispatch never spawns a real claude, but
 * the mock INSERTS a real runs row (the K thread + agent_runs rows FK → runs(id)).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db.js'
import { createProfile, getProfile } from '../src/profiles.js'

// Mock the supervisor so a 201 path never spawns a real process, but insert a real
// runs row (FK targets). REPO_ROOT etc. stay real (spread ...actual).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-k-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

let createdKSecretary = false

function resetKState() {
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = 'k-secretary'`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%'`).run()
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  // Guard-create only 'k-secretary' (K_SKIP_BOOTSTRAP skips seedProfiles in start()).
  // Do NOT call seedProfiles() — the full durable roster is a global invariant
  // profiles.test.ts asserts on a clean DB. Clean up if we made it.
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
  app = await buildApp()
  await app.ready()
  resetKState()
})

afterAll(async () => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  await app.close()
})

describe('POST /api/k/ask — validation + dispatch', () => {
  it('no body → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/k/ask', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })

  it('empty message → 400 (min(1))', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/k/ask', headers: AUTH, payload: { message: '' } })
    expect(res.statusCode).toBe(400)
  })

  it('valid message → 201 with route preview, runId, warm=false', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'what is on my calendar' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as {
      route: { target: string }
      runId: string
      warm: boolean
    }
    expect(body.route.target).toBe('logistics')
    expect(typeof body.runId).toBe('string')
    expect(body.warm).toBe(false)
  })
})

describe('GET /api/k/thread', () => {
  it('returns the durable thread + turns including the asked message', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/k/thread', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      thread: { id: string }
      turns: Array<{ role: string; text: string }>
    }
    expect(body.thread).toBeTruthy()
    expect(Array.isArray(body.turns)).toBe(true)
    expect(body.turns.some(t => t.text === 'what is on my calendar')).toBe(true)
  })
})
