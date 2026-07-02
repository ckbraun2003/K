/**
 * C2 — K-home glance reads (routes/k.ts): GET /api/k/notes + GET /api/k/schedule.
 *
 * Builds the real Fastify app in-process (buildApp) and drives it with app.inject —
 * same bootstrap as k-route.test.ts (K_SKIP_BOOTSTRAP set before importing index).
 * These routes never dispatch, so no supervisor mock is needed. The logistics tables
 * are wiped in beforeAll/afterAll (mirrors k-route.test.ts's whole-table resetKState:
 * suites clean up after themselves on the shared K_DATA_DIR, so the wipe is a
 * defensive no-op that also guarantees the empty-state assertions below).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import type { Note, KSchedule } from '@k/shared'
import { db, logisticsDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

function wipeLogistics() {
  db.prepare('DELETE FROM logistics_notes').run()
  db.prepare('DELETE FROM logistics_events').run()
  db.prepare('DELETE FROM logistics_reminders').run()
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  wipeLogistics()
})

afterAll(async () => {
  wipeLogistics()
  await app.close()
})

describe('auth', () => {
  it('401 without the Bearer header on both glance reads', async () => {
    for (const url of ['/api/k/notes', '/api/k/schedule']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(401)
    }
  })
})

describe('GET /api/k/notes + /api/k/schedule — empty store', () => {
  it('empty DB → 200 [] (notes) and 200 {events:[],reminders:[]} (schedule) — never a 404', async () => {
    const notes = await app.inject({ method: 'GET', url: '/api/k/notes', headers: AUTH })
    expect(notes.statusCode).toBe(200)
    expect(notes.json()).toEqual([])

    const schedule = await app.inject({ method: 'GET', url: '/api/k/schedule', headers: AUTH })
    expect(schedule.statusCode).toBe(200)
    expect(schedule.json()).toEqual({ events: [], reminders: [] })
  })
})

describe('GET /api/k/notes — seeded', () => {
  it('returns the seeded note mapped through rowToNote (camelCase, done boolean)', async () => {
    const now = Date.now()
    const noteId = uuid()
    logisticsDb.insertNote.run({
      id: noteId, runId: null, body: 'c2 glance note', done: 0, createdAt: now, updatedAt: now,
    })

    const res = await app.inject({ method: 'GET', url: '/api/k/notes', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Note[]
    const note = body.find(n => n.id === noteId)
    expect(note).toMatchObject({ id: noteId, body: 'c2 glance note', done: false, runId: null })
    expect(typeof note!.createdAt).toBe('number')
  })
})

describe('GET /api/k/schedule — windowing', () => {
  it('includes a future event + a pending (overdue) reminder; excludes a past event + a done reminder', async () => {
    const now = Date.now()
    const futureEventId = uuid()
    const pastEventId = uuid()
    const overdueReminderId = uuid()
    const doneReminderId = uuid()

    logisticsDb.insertEvent.run({
      id: futureEventId, runId: null, title: 'c2 future event',
      startsAt: now + 3_600_000, endsAt: null, location: null, createdAt: now, updatedAt: now,
    })
    // A past event must NOT appear — the schedule card shows what's coming, not history.
    logisticsDb.insertEvent.run({
      id: pastEventId, runId: null, title: 'c2 past event',
      startsAt: now - 3_600_000, endsAt: null, location: null, createdAt: now, updatedAt: now,
    })
    // An OVERDUE pending reminder MUST appear (the most important thing to show).
    logisticsDb.insertReminder.run({
      id: overdueReminderId, runId: null, text: 'c2 overdue reminder',
      remindAt: now - 60_000, status: 'pending', createdAt: now, updatedAt: now,
    })
    // A 'done' reminder must NOT appear.
    logisticsDb.insertReminder.run({
      id: doneReminderId, runId: null, text: 'c2 done reminder',
      remindAt: now + 60_000, status: 'done', createdAt: now, updatedAt: now,
    })

    const res = await app.inject({ method: 'GET', url: '/api/k/schedule', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as KSchedule

    expect(body.events.map(e => e.id)).toContain(futureEventId)
    expect(body.events.map(e => e.id)).not.toContain(pastEventId)
    // Mapped shape (rowToCalendarEvent): camelCase startsAt, nullable endsAt.
    const ev = body.events.find(e => e.id === futureEventId)!
    expect(ev.title).toBe('c2 future event')
    expect(ev.endsAt).toBeNull()

    expect(body.reminders.map(r => r.id)).toContain(overdueReminderId)
    expect(body.reminders.map(r => r.id)).not.toContain(doneReminderId)
    expect(body.reminders.find(r => r.id === overdueReminderId)!.status).toBe('pending')
  })
})
