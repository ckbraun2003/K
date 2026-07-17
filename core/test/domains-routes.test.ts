import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db } from '../src/db.js'

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const JSON_H = { ...AUTH, 'content-type': 'application/json' }
let app: FastifyInstance
const createdDomains: string[] = []

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1' // MUST precede the import
  const { buildApp } = await import('../src/index.js')
  const { seedProfiles } = await import('../src/profiles.js')
  const { stampSeededDomainMemberships } = await import('../src/domains.js')
  seedProfiles(); stampSeededDomainMemberships()
  app = await buildApp(); await app.ready()
})
afterAll(async () => {
  for (const id of createdDomains) db.prepare(`DELETE FROM domains WHERE id = ?`).run(id)
  await app.close()
})

describe('/api/domains (C.1)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/domains' })
    expect(res.statusCode).toBe(401)
  })

  it('GET lists domains with managerName enrichment', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/domains', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const eng = (res.json() as Array<Record<string, unknown>>).find(d => d.id === 'engineering')
    expect(eng).toMatchObject({ name: 'Engineering', managerProfileId: 'chief', managerName: 'Chief' })
  })

  it('POST creates a domain (201), rejects duplicates (409) and bad bodies (400)', async () => {
    const name = `P51 Route ${randomUUID().slice(0, 8)}`
    const res = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ name, description: 'd' }) })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    createdDomains.push(String(body.id))
    expect(body).toMatchObject({ name, description: 'd', managerProfileId: null, managerName: null })

    const dup = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ name }) })
    expect(dup.statusCode).toBe(409)

    const bad = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ nope: 1 }) })
    expect(bad.statusCode).toBe(400)

    // un-sluggable name is body VALIDATION (400), not a conflict (quality-review m3)
    const unslug = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ name: '!!!' }) })
    expect(unslug.statusCode).toBe(400)
  })

  it('PATCH updates fields, 404s unknown domains, 400s unknown manager profiles + empty patches', async () => {
    const name = `P51 Patch ${randomUUID().slice(0, 8)}`
    const created = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ name }) })
    const id = String((created.json() as Record<string, unknown>).id)
    createdDomains.push(id)

    const ok = await app.inject({ method: 'PATCH', url: `/api/domains/${id}`, headers: JSON_H,
      payload: JSON.stringify({ description: 'patched', managerProfileId: 'chief' }) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ description: 'patched', managerProfileId: 'chief', managerName: 'Chief' })

    expect((await app.inject({ method: 'PATCH', url: `/api/domains/nope-${randomUUID()}`, headers: JSON_H,
      payload: JSON.stringify({ description: 'x' }) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/api/domains/${id}`, headers: JSON_H,
      payload: JSON.stringify({ managerProfileId: 'nope-' + randomUUID() }) })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/api/domains/${id}`, headers: JSON_H,
      payload: JSON.stringify({}) })).statusCode).toBe(400)
  })

  it('PATCH rename onto an existing name → clean 409 (never a raw SQLITE 500); whitespace name → 400', async () => {
    const name = `P51 Ren ${randomUUID().slice(0, 8)}`
    const created = await app.inject({ method: 'POST', url: '/api/domains', headers: JSON_H,
      payload: JSON.stringify({ name }) })
    const id = String((created.json() as Record<string, unknown>).id)
    createdDomains.push(id)

    const dup = await app.inject({ method: 'PATCH', url: `/api/domains/${id}`, headers: JSON_H,
      payload: JSON.stringify({ name: 'ENGINEERING' }) }) // case-insensitive collision
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { error: string }).error).not.toContain('SQLITE') // no internals leak

    const ws = await app.inject({ method: 'PATCH', url: `/api/domains/${id}`, headers: JSON_H,
      payload: JSON.stringify({ name: '   ' }) })
    expect(ws.statusCode).toBe(400)
  })
})
