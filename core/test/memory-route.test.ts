/**
 * P5.1b — Memory-gate HTTP route tests (core/src/routes/memory.ts).
 *
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it with app.inject —
 * no socket, no scheduler. Seeds PENDING lessons via agentMemoryDb.insertLesson — the SAME producer
 * statement kstore's lesson_propose uses — so approve/reject are proven to flip the exact row the
 * producer wrote (SEAMS). A seeded agent_profiles row + raw UPDATE of the lesson's profile_id asserts
 * the profile_name join. Wipes agent_memory before/after (shared K_DATA_DIR singleton, serial fork).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, agentMemoryDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

interface LessonBody {
  id: string
  runId: string | null
  profileId: string | null
  profileName: string | null
  lesson: string
  status: string
  createdAt: number
  reviewedAt: number | null
}

let app: FastifyInstance
const PROFILE_ID = `prof-${uuid()}`
const PROFILE_NAME = 'K'

/** Seed a pending lesson via the PRODUCER statement (run_id null — FK is ON DELETE SET NULL, so a
 *  null owner keeps the seed simple). profileId is null here; the profile_name-join test stamps
 *  profile_id with a raw UPDATE below. Returns its id. */
function seedPendingLesson(lesson: string): string {
  const id = uuid()
  agentMemoryDb.insertLesson.run({
    id,
    runId: null,
    lesson,
    status: 'pending',
    createdAt: Date.now(),
    reviewedAt: null,
    profileId: null,
  })
  return id
}

beforeAll(async () => {
  db.exec('DELETE FROM agent_memory')
  // A profile to assert the join surfaces profile_name. seedPendingLesson inserts profile_id null,
  // so the join test stamps profile_id with a raw UPDATE on the seeded lesson below.
  db.prepare(
    `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
     VALUES (?, ?, 'chief', 'chief', 'sonnet', '[]', '[]', '[]', ?)`,
  ).run(PROFILE_ID, PROFILE_NAME, Date.now())

  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  db.exec('DELETE FROM agent_memory')
  db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(PROFILE_ID)
  await app.close()
})

describe('GET /api/memory/lessons', () => {
  it('default (pending) lists the seeded pending lesson with its joined profileName', async () => {
    const id = seedPendingLesson('always run typecheck before commit')
    db.prepare('UPDATE agent_memory SET profile_id = ? WHERE id = ?').run(PROFILE_ID, id)

    const res = await app.inject({ method: 'GET', url: '/api/memory/lessons', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as LessonBody[]
    const me = rows.find(r => r.id === id)
    expect(me).toBeDefined()
    expect(me!.status).toBe('pending')
    expect(me!.lesson).toBe('always run typecheck before commit')
    expect(me!.profileId).toBe(PROFILE_ID)
    expect(me!.profileName).toBe(PROFILE_NAME)
    expect(me!.reviewedAt).toBeNull()
  })

  it('?status=accepted returns [] before any approval', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/lessons?status=accepted', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('?status=bogus → 400 invalid status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/lessons?status=bogus', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/invalid status/i)
  })

  it('?profileId=<seeded> filters to only that profile\'s lessons', async () => {
    // One lesson bound to PROFILE_ID, one unassigned — the filter should exclude the unassigned one.
    const bound = seedPendingLesson('bound lesson')
    db.prepare('UPDATE agent_memory SET profile_id = ? WHERE id = ?').run(PROFILE_ID, bound)
    seedPendingLesson('unassigned lesson')

    const res = await app.inject({
      method: 'GET',
      url: `/api/memory/lessons?profileId=${PROFILE_ID}`,
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as LessonBody[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.profileId === PROFILE_ID)).toBe(true)
    expect(rows.some(r => r.id === bound)).toBe(true)
  })
})

describe('POST /api/memory/lessons/:id/approve', () => {
  it('200 flips pending→accepted, stamps reviewedAt, and mutates the SAME producer row (SEAMS)', async () => {
    const id = seedPendingLesson('lesson to approve')

    const res = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/approve`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as LessonBody
    expect(body.status).toBe('accepted')
    expect(body.reviewedAt).not.toBeNull()

    // SEAMS proof: the producer's own getLesson (by primary key) sees the same row now 'accepted'.
    const raw = agentMemoryDb.getLesson.get(id) as { status: string; reviewed_at: number | null }
    expect(raw.status).toBe('accepted')
    expect(raw.reviewed_at).not.toBeNull()
  })

  it('409 when approving a lesson that is no longer pending', async () => {
    const id = seedPendingLesson('double-approve')
    const first = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/approve`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/approve`, headers: AUTH })
    expect(second.statusCode).toBe(409)
    expect((second.json() as { error: string }).error).toMatch(/not pending/i)
  })

  it('404 approving an unknown id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/lessons/__missing__/approve', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/memory/lessons/:id/reject', () => {
  it('200 flips pending→rejected', async () => {
    const id = seedPendingLesson('lesson to reject')
    const res = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/reject`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as LessonBody
    expect(body.status).toBe('rejected')
    expect(body.reviewedAt).not.toBeNull()
    const raw = agentMemoryDb.getLesson.get(id) as { status: string }
    expect(raw.status).toBe('rejected')
  })

  it('409 when rejecting a lesson that is no longer pending', async () => {
    const id = seedPendingLesson('double-reject')
    const first = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/reject`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: `/api/memory/lessons/${id}/reject`, headers: AUTH })
    expect(second.statusCode).toBe(409)
    expect((second.json() as { error: string }).error).toMatch(/not pending/i)
  })

  it('404 rejecting an unknown id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/lessons/__missing__/reject', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})

describe('auth', () => {
  it('401 without the Bearer header (route is behind the global auth hook)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/lessons' })
    expect(res.statusCode).toBe(401)
  })
})
