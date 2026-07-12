/**
 * k threads CRUD routes + askK threadId (UI Simplification, Task 2) —
 * GET/POST /api/k/threads, GET/PATCH/DELETE /api/k/threads/:id, POST /api/k/ask
 * threadId.
 *
 * Same harness shape as k-route.test.ts: builds the real Fastify app in-process
 * (buildApp) and drives it with app.inject. The supervisor is mocked so askK's
 * fresh dispatch never spawns a real claude, but the mock INSERTS a real runs row
 * (the K thread + agent_runs rows FK → runs(id)).
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
let createdChief = false

function resetKState() {
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare('DELETE FROM user_memories').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('k-secretary', 'chief')`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  // 'live-1' is the fixed id the DELETE-guard test stamps directly via SQL.
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%' OR id = 'live-1'`).run()
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  // Guard-create only 'k-secretary' (the fresh path) + 'chief' (the delegation
  // path) — K_SKIP_BOOTSTRAP skips seedProfiles in start(). Do NOT call
  // seedProfiles() — the full durable roster is a global invariant profiles.test.ts
  // asserts on a clean DB. Clean up what we made.
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
  if (!getProfile('chief')) {
    createProfile({ id: 'chief', name: 'Chief', tier: 'chief' })
    createdChief = true
  }
  app = await buildApp()
  await app.ready()
  resetKState()
})

afterAll(async () => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  if (createdChief) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
  await app.close()
})

describe('POST /api/k/threads + GET /api/k/threads', () => {
  it('POST /api/k/threads creates an empty thread; GET lists it newest-first with null snippet', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })
    expect(created.statusCode).toBe(201)
    const thread = created.json()
    expect(thread.title).toBeNull()
    expect(thread.archivedAt).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/api/k/threads', headers: AUTH })
    const threads = list.json().threads
    expect(threads[0].id).toBe(thread.id)
    expect(threads[0].snippet).toBeNull()
  })
})

describe('POST /api/k/ask threadId', () => {
  it('POST /api/k/ask with threadId appends to THAT thread and sets its title from the first message', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })).json()
    const ask = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'remind me to water the plants tomorrow', threadId: t.id },
    })
    expect(ask.statusCode).toBe(201)
    const row = db.prepare(`SELECT title FROM k_threads WHERE id = ?`).get(t.id) as { title: string }
    expect(row.title).toBe('remind me to water the plants tomorrow')
    const turns = db.prepare(`SELECT thread_id FROM k_thread_turns WHERE thread_id = ?`).all(t.id)
    expect(turns.length).toBeGreaterThan(0)
  })

  it('POST /api/k/ask with an unknown threadId is a 404, and appends nothing anywhere', async () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM k_thread_turns`).get() as { n: number }
    const ask = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'hello', threadId: 'kt-nope' },
    })
    expect(ask.statusCode).toBe(404)
    const after = db.prepare(`SELECT COUNT(*) AS n FROM k_thread_turns`).get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})

describe('PATCH /api/k/threads/:id', () => {
  it('PATCH renames and archives; archived threads drop out of the default list but show with ?archived=1', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })).json()
    const patched = await app.inject({
      method: 'PATCH', url: `/api/k/threads/${t.id}`, headers: AUTH,
      payload: { title: 'Groceries', archived: true },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().title).toBe('Groceries')
    expect(patched.json().archivedAt).not.toBeNull()
    const def = (await app.inject({ method: 'GET', url: '/api/k/threads', headers: AUTH })).json().threads
    expect(def.some((x: { id: string }) => x.id === t.id)).toBe(false)
    const all = (await app.inject({ method: 'GET', url: '/api/k/threads?archived=1', headers: AUTH })).json().threads
    expect(all.some((x: { id: string }) => x.id === t.id)).toBe(true)
  })
})

describe('DELETE /api/k/threads/:id', () => {
  it('DELETE cascades turns; DELETE with a live active run is 409', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })).json()
    await app.inject({ method: 'POST', url: '/api/k/ask', headers: AUTH, payload: { message: 'hi', threadId: t.id } })
    // live-run guard: stamp a running run as the thread's active run
    db.prepare(`INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES ('live-1', 'x', '.', 'running', ?)`).run(Date.now())
    db.prepare(`UPDATE k_threads SET active_run_id = 'live-1' WHERE id = ?`).run(t.id)
    const blocked = await app.inject({ method: 'DELETE', url: `/api/k/threads/${t.id}`, headers: AUTH })
    expect(blocked.statusCode).toBe(409)
    db.prepare(`UPDATE runs SET status = 'done' WHERE id = 'live-1'`).run()
    const gone = await app.inject({ method: 'DELETE', url: `/api/k/threads/${t.id}`, headers: AUTH })
    expect(gone.statusCode).toBe(204)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM k_thread_turns WHERE thread_id = ?`).get(t.id)).toEqual({ n: 0 })
  })
})

describe('GET /api/k/threads/:id', () => {
  it('GET /api/k/threads/:id returns that thread with its turns, oldest-first; unknown id is 404', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })).json()
    await app.inject({ method: 'POST', url: '/api/k/ask', headers: AUTH, payload: { message: 'first', threadId: t.id } })
    const res = await app.inject({ method: 'GET', url: `/api/k/threads/${t.id}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().thread.id).toBe(t.id)
    expect(res.json().turns[0].text).toBe('first')
    expect((await app.inject({ method: 'GET', url: '/api/k/threads/kt-nope', headers: AUTH })).statusCode).toBe(404)
  })
})

describe('askK fallback un-archive (review fix)', () => {
  it('ask with no threadId after archiving EVERY thread un-archives the resolved thread (message never lands hidden)', async () => {
    // Archive everything that exists so the fallback branch is the only path left.
    const archiveAll = async () => {
      const all = (await app.inject({ method: 'GET', url: '/api/k/threads?archived=1', headers: AUTH })).json()
        .threads as Array<{ id: string }>
      for (const t of all) {
        await app.inject({ method: 'PATCH', url: `/api/k/threads/${t.id}`, headers: AUTH, payload: { archived: true } })
      }
    }
    await archiveAll()
    // With zero non-archived threads resolveAskThread falls back to the default
    // thread, CREATING it (fresh, unarchived) via an ask — then archive that too,
    // so the default thread now EXISTS in the archived state (the bug's precondition).
    const seed = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH, payload: { message: 'seed the default thread' },
    })
    const defId = (seed.json() as { kThreadId: string }).kThreadId
    await archiveAll()
    expect(
      (db.prepare(`SELECT archived_at FROM k_threads WHERE id = ?`).get(defId) as { archived_at: number | null })
        .archived_at,
    ).not.toBeNull()

    const ask = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'hello after archiving everything' },
    })
    expect(ask.statusCode).toBe(201)
    const askedThreadId = ask.json().kThreadId as string
    // (a) the resolved thread is live again…
    const thread = (await app.inject({ method: 'GET', url: `/api/k/threads/${askedThreadId}`, headers: AUTH })).json()
      .thread
    expect(thread.archivedAt).toBeNull()
    // (b) …and therefore visible in the default (non-archived) list.
    const visible = (await app.inject({ method: 'GET', url: '/api/k/threads', headers: AUTH })).json()
      .threads as Array<{ id: string }>
    expect(visible.some(t => t.id === askedThreadId)).toBe(true)
  })
})

describe('askK explicit-threadId un-archive (final-review fix)', () => {
  it('ask WITH an explicit threadId un-archives that thread too (not just the no-threadId fallback path)', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH, payload: {} })).json()
    await app.inject({
      method: 'PATCH', url: `/api/k/threads/${t.id}`, headers: AUTH, payload: { archived: true },
    })
    expect(
      (db.prepare(`SELECT archived_at FROM k_threads WHERE id = ?`).get(t.id) as { archived_at: number | null })
        .archived_at,
    ).not.toBeNull()

    const ask = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'hello to an archived thread, explicitly', threadId: t.id },
    })
    expect(ask.statusCode).toBe(201)

    // (a) the explicitly-targeted thread is live again…
    const thread = (await app.inject({ method: 'GET', url: `/api/k/threads/${t.id}`, headers: AUTH })).json().thread
    expect(thread.archivedAt).toBeNull()
    // (b) …and therefore visible in the default (non-archived) list.
    const visible = (await app.inject({ method: 'GET', url: '/api/k/threads', headers: AUTH })).json()
      .threads as Array<{ id: string }>
    expect(visible.some(v => v.id === t.id)).toBe(true)
  })
})
