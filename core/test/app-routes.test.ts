/**
 * E3 — HTTP-layer route-contract tests.
 *
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it
 * with app.inject — no socket, no poller, no dev server. Verifies the auth hook,
 * the public-path exemptions, and the validation status codes across runs and
 * artifacts routes.
 *
 * Bootstrap is skipped via K_SKIP_BOOTSTRAP (set before importing index) so the
 * top-level listen()/poller never runs. The supervisor is mocked so POST /api/runs
 * never spawns a claude process. DB is isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import { runsDb, eventsDb, db } from '../src/db.js'

// Mock the supervisor so a 201 path never spawns a real process. Keep REPO_ROOT
// real so the default-cwd allow path still resolves (mirrors runs-cwd.test.ts).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

beforeAll(async () => {
  // Must be set BEFORE importing index.ts so the top-level start() is skipped.
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ── auth hook ───────────────────────────────────────────────────────────────────

describe('auth hook', () => {
  it('protected route with no Authorization → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('unauthorized')
  })

  it('protected route with wrong token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer nope' } })
    expect(res.statusCode).toBe(401)
  })

  it('protected route with correct Bearer token → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('/health is exempt → 200 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it('/health with a query string is still exempt → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health?x=1' })
    expect(res.statusCode).toBe(200)
  })
})

// ── POST /api/runs validation ─────────────────────────────────────────────────

describe('POST /api/runs — validation', () => {
  it('missing prompt → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('empty prompt → 400 (min(1))', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { prompt: '' } })
    expect(res.statusCode).toBe(400)
  })

  it('bogus cwd outside any project/REPO_ROOT → 400', async () => {
    const evil = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { prompt: 'hi', cwd: evil } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cwd not under a registered project/)
  })

  it('bogus projectId (valid uuid, not in DB) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/runs', headers: AUTH,
      payload: { prompt: 'hi', projectId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown projectId')
  })

  it('malformed projectId (not a uuid) → 400 (schema reject)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/runs', headers: AUTH,
      payload: { prompt: 'hi', projectId: 'not-a-uuid' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('valid prompt (no cwd) → 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { prompt: 'hi' } })
    expect(res.statusCode).toBe(201)
  })
})

// ── GET /api/runs query validation ──────────────────────────────────────────────

describe('GET /api/runs — query validation', () => {
  it('?status=bogus → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?status=bogus', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
  it('?limit=0 → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?limit=0', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
  it('?limit=99999 → 400 (over max 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?limit=99999', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
  it('?status=done&limit=10 → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?status=done&limit=10', headers: AUTH })
    expect(res.statusCode).toBe(200)
  })
})

// ── per-event raw endpoint ───────────────────────────────────────────────────────

describe('GET /api/runs/:id/events/:seq/raw', () => {
  it('non-numeric seq → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/some-run/events/abc/raw', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
  it('negative seq → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/some-run/events/-1/raw', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
  it('valid seq but unknown run → 404 (no such event)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/no-such-run/events/0/raw', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})

// ── events list projection: context_tokens → contextTokens (Wave D6) ─────────────

describe('GET /api/runs/:id/events — contextTokens projection', () => {
  const RID = uuid()
  beforeAll(() => {
    runsDb.insertRun.run({
      id: RID, prompt: 'ctx projection', cwd: '/tmp', worktree: null, status: 'done',
      provider: 'claude', model: 'claude-opus-4-8', tokensIn: 100, tokensOut: 20,
      costUsd: 0, projectId: null, createdAt: Date.now(),
    })
    eventsDb.insertEvent.run({
      id: uuid(), runId: RID, seq: 1, type: 'assistant', ts: Date.now(),
      raw: null, text: 'hi', tool: null, tokensIn: 100, tokensOut: 20, costUsd: null,
      toolUseId: null, toolKind: null, toolInput: null, toolResult: null,
      toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: 6100,
    })
  })
  afterAll(() => {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(RID)
    db.prepare('DELETE FROM runs WHERE id = ?').run(RID)
  })

  it('projects the persisted context_tokens column back as contextTokens', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${RID}/events`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const ev = (res.json() as Array<Record<string, unknown>>).find(e => e.seq === 1)!
    expect(ev.contextTokens).toBe(6100)
    expect(ev.tokensIn).toBe(100) // fresh-input projection unchanged
  })
})

// ── artifacts route-level slug rejection (complements the unit test) ─────────────

describe('PUT /api/artifacts/:slug — traversal rejection at the route', () => {
  it('encoded traversal slug → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/artifacts/..%2f..%2f.env', headers: AUTH, payload: { md: '# x' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('dotted slug → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/artifacts/.env', headers: AUTH, payload: { md: '# x' },
    })
    expect(res.statusCode).toBe(400)
  })
})
