import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { db, proposalsDb } from '../src/db.js'
import { randomUUID } from 'crypto'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
let app: FastifyInstance
beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
})
afterAll(async () => { await app.close() })

describe('inbox proposals', () => {
  beforeEach(() => { db.prepare(`DELETE FROM work_items`).run() })
  it('surfaces a blocked proposal and approve flips it to open', async () => {
    const id = randomUUID()
    proposalsDb.insertProposal.run({ id, title: 'fix ci', body: null, projectId: null, source: 'ci_failed', sourceKey: 'ci_failed:x', createdAt: 1 })
    const list = await app.inject({ method: 'GET', url: '/api/inbox', headers: AUTH })
    expect(list.json().counts.proposal).toBe(1)
    expect(list.json().items.some((i: any) => i.kind === 'proposal' && i.workItemId === id)).toBe(true)
    const ok = await app.inject({ method: 'POST', url: `/api/inbox/proposals/${id}/approve`, headers: AUTH })
    expect(ok.statusCode).toBe(204)
    expect((db.prepare(`SELECT status FROM work_items WHERE id=?`).get(id) as any).status).toBe('open')
    const again = await app.inject({ method: 'POST', url: `/api/inbox/proposals/${id}/approve`, headers: AUTH })
    expect(again.statusCode).toBe(404) // no longer approvable
  })

  it('dismiss flips a blocked proposal to cancelled', async () => {
    const id = randomUUID()
    proposalsDb.insertProposal.run({ id, title: 'fix bible', body: null, projectId: null, source: 'stale_bible', sourceKey: 'stale_bible:y', createdAt: 1 })
    const ok = await app.inject({ method: 'POST', url: `/api/inbox/proposals/${id}/dismiss`, headers: AUTH })
    expect(ok.statusCode).toBe(204)
    expect((db.prepare(`SELECT status FROM work_items WHERE id=?`).get(id) as any).status).toBe('cancelled')
    const again = await app.inject({ method: 'POST', url: `/api/inbox/proposals/${id}/dismiss`, headers: AUTH })
    expect(again.statusCode).toBe(404) // already dismissed, no longer actionable
  })

  it('approve/dismiss on an unknown id 404s', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/inbox/proposals/${randomUUID()}/approve`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})
