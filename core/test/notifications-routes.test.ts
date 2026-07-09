/**
 * P2 B2 — notification center + rules routes. Pure HTTP over seeded rows via
 * buildApp+inject (inbox-routes.test.ts precedent). HERMETIC against the shared
 * singleFork DB: the notify-engine test leaks a `verify_fail` row whose title/body
 * don't match its own cleanup filter, so we wipe the notifications table in
 * beforeAll and assert on OUR seeded ids/counts only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, notificationsDb } from '../src/db.js'
import type { Notification, NotificationRule } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

const AUTH = { authorization: 'Bearer ' + (process.env.HARNESS_TOKEN ?? 'dev-token-change-me') }

let app: FastifyInstance
// Three seeded rows, distinct createdAt so newest-first order is testable:
//   nA (newest, unread), nB (middle, unread), nC (oldest, already read) → unread = 2.
const nA = randomUUID(), nB = randomUUID(), nC = randomUUID()
const SEEDED = new Set([nA, nB, nC])
const SEEDED_UNREAD = 2

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  db.prepare('DELETE FROM notifications').run() // drop any leaked/startup rows → hermetic
  notificationsDb.insertNotification.run({ id: nC, eventKey: 'run_review_ready', title: 'oldest read',
    body: null, runId: null, projectId: null, createdAt: 1000, readAt: 1500 })
  notificationsDb.insertNotification.run({ id: nB, eventKey: 'run_awaiting_input', title: 'middle unread',
    body: 'reply please', runId: null, projectId: null, createdAt: 2000, readAt: null })
  notificationsDb.insertNotification.run({ id: nA, eventKey: 'run_awaiting_plan', title: 'newest unread',
    body: null, runId: null, projectId: null, createdAt: 3000, readAt: null })
})
afterAll(async () => {
  db.prepare('DELETE FROM notifications').run()
  await app.close()
})

describe('GET /api/notifications', () => {
  it('returns rows newest-first with the seeded unread count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { notifications: Notification[]; unread: number }
    expect(body.notifications.map(n => n.id)).toEqual([nA, nB, nC]) // createdAt DESC
    expect(body.unread).toBe(SEEDED_UNREAD)
    expect(body.notifications.every(n => SEEDED.has(n.id))).toBe(true)
  })

  it('respects ?limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications?limit=1', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { notifications: Notification[]; unread: number }
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0].id).toBe(nA) // the newest
  })
})

describe('POST /api/notifications/:id/read', () => {
  it('stamps an unread row once (204), then 404 on re-read and on unknown id', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/notifications/${nB}/read`, headers: AUTH })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `/api/notifications/${nB}/read`, headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/notifications/${randomUUID()}/read`, headers: AUTH })).statusCode).toBe(404)
  })
})

describe('POST /api/notifications/read-all', () => {
  it('marks the remaining unread and leaves unread at 0', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/notifications', headers: AUTH })).json() as { unread: number }
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { marked: number }).marked).toBe(before.unread)
    const after = (await app.inject({ method: 'GET', url: '/api/notifications', headers: AUTH })).json() as { unread: number }
    expect(after.unread).toBe(0)
  })
})

describe('GET /api/notifications/rules', () => {
  it('returns all five seeded rules with boolean channels', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications/rules', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const rules = res.json() as NotificationRule[]
    expect(rules).toHaveLength(5)
    expect(rules.map(r => r.eventKey).sort()).toEqual(
      ['run_awaiting_input', 'run_awaiting_plan', 'run_failed', 'run_review_ready', 'verify_fail'])
    expect(rules.every(r => typeof r.inapp === 'boolean' && typeof r.browser === 'boolean')).toBe(true)
  })
})

describe('PATCH /api/notifications/rules/:eventKey', () => {
  it('updates a channel and returns the rule (restored afterward)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/notifications/rules/run_failed',
      headers: AUTH, payload: { browser: true } })
    expect(res.statusCode).toBe(200)
    const rule = res.json() as NotificationRule
    expect(rule).toMatchObject({ eventKey: 'run_failed', browser: true })
    // restore the seed so other test files see run_failed with browser off
    const restore = await app.inject({ method: 'PATCH', url: '/api/notifications/rules/run_failed',
      headers: AUTH, payload: { browser: false } })
    expect(restore.statusCode).toBe(200)
    expect((restore.json() as NotificationRule).browser).toBe(false)
  })

  it('400s an unknown key and an empty body', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/notifications/rules/not_a_key',
      headers: AUTH, payload: { browser: true } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/notifications/rules/run_failed',
      headers: AUTH, payload: {} })).statusCode).toBe(400)
  })
})
