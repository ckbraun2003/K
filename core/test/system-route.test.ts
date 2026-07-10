/**
 * Wave 2 — System Doctor route contract (GET /api/system/doctor).
 *
 * Drives the real in-process app (buildApp from index.ts) with app.inject — no
 * socket, no poller. Bootstrap is skipped via K_SKIP_BOOTSTRAP (set before importing
 * index) so start()/pollers never run. Asserts the endpoint requires auth (401
 * without a Bearer) and, when authed, returns a 200 DoctorReport whose tools cover
 * the five catalog ids plus an `ok` boolean. Tool PRESENCE is environment-dependent
 * (claude/gh/ollama may be absent in CI) so it is NOT asserted — only the SHAPE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DoctorReportSchema } from '@k/shared'

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

describe('GET /api/system/doctor', () => {
  it('requires auth → 401 without a Bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/doctor' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('unauthorized')
  })

  it('authed → 200 with a well-formed DoctorReport (5 tools + ok)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/doctor', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Validate against the shared contract (source of truth).
    expect(DoctorReportSchema.safeParse(body).success).toBe(true)
    expect(typeof body.ok).toBe('boolean')
    expect(body.tools.map((t: { id: string }) => t.id).sort()).toEqual(
      ['claude', 'gh', 'git', 'node', 'ollama'],
    )
  })
})
