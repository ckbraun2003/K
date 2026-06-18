/**
 * Skill registry route tests — POST/GET /api/skills.
 *
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it
 * with app.inject — no socket, no scheduler/event listener (those create timers
 * that keep the process alive). DB is isolated via vitest.config.ts K_DATA_DIR.
 *
 * Bootstrap is skipped via K_SKIP_BOOTSTRAP (set before importing index) so the
 * top-level listen()/poller never runs. Supervisor is mocked so triggerSkill's
 * startRun never spawns a real process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// Unique suffix so created skill names don't collide with other suites / runs.
const SFX = uuid().slice(0, 8)
const createdNames: string[] = []
// Names that returned 201 — these must show up in GET /api/skills.
const persistedNames: string[] = []

let app: FastifyInstance

function makeSkill(over: Record<string, unknown>): Record<string, unknown> {
  const name = `skill-route-test-${SFX}-${createdNames.length}`
  createdNames.push(name)
  return {
    name,
    type: 'skill',
    source: 'do the thing',
    triggerType: 'manual',
    ...over,
  }
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  for (const name of createdNames) {
    try { db.prepare('DELETE FROM skills WHERE name = ?').run(name) } catch { /* ignore */ }
  }
  await app.close()
})

describe('POST /api/skills — trigger-type / field validation', () => {
  it('400 when triggerType=schedule and schedule is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: AUTH,
      payload: makeSkill({ triggerType: 'schedule' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cron/i)
  })

  it('400 when triggerType=schedule and cron is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: AUTH,
      payload: makeSkill({ triggerType: 'schedule', schedule: 'not a cron' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cron/i)
  })

  it('201 when triggerType=schedule and cron is valid', async () => {
    const payload = makeSkill({ triggerType: 'schedule', schedule: '*/5 * * * *' })
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    expect(res.statusCode).toBe(201)
    const skill = res.json()
    expect(skill.triggerType).toBe('schedule')
    expect(skill.schedule).toBe('*/5 * * * *')
    persistedNames.push(payload.name as string)
  })

  it('400 when triggerType=event and eventTrigger is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: AUTH,
      payload: makeSkill({ triggerType: 'event' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/event/i)
  })

  it('201 when triggerType=manual (needs neither schedule nor eventTrigger)', async () => {
    const payload = makeSkill({ triggerType: 'manual' })
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    expect(res.statusCode).toBe(201)
    expect(res.json().triggerType).toBe('manual')
    persistedNames.push(payload.name as string)
  })
})

describe('GET /api/skills', () => {
  it('returns the created skill(s)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const skills = res.json() as Array<{ name: string }>
    expect(Array.isArray(skills)).toBe(true)
    // Every skill that returned 201 above must appear in the listing.
    const names = new Set(skills.map(s => s.name))
    expect(persistedNames.length).toBeGreaterThan(0)
    for (const n of persistedNames) {
      expect(names.has(n)).toBe(true)
    }
  })
})
