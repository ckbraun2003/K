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

  it('F-016: create with enabled:false lands DISABLED (a "disabled" skill must not be armed)', async () => {
    const payload = makeSkill({ triggerType: 'manual', enabled: false })
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    expect(res.statusCode).toBe(201)
    expect(res.json().enabled).toBe(false)
    persistedNames.push(payload.name as string)
  })

  it('F-016: create with enabled omitted defaults to ENABLED (preserves prior behavior)', async () => {
    const payload = makeSkill({ triggerType: 'manual' })
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    expect(res.statusCode).toBe(201)
    expect(res.json().enabled).toBe(true)
    persistedNames.push(payload.name as string)
  })
})

describe('PATCH /api/skills/:id — body validation', () => {
  let id: string
  beforeAll(async () => {
    const payload = makeSkill({ triggerType: 'manual' })
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    persistedNames.push(payload.name as string)
    id = res.json().id
  })

  it('400 when patching schedule with an invalid cron expression', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { schedule: 'not a cron' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json().error)).toMatch(/cron/i)
  })

  it('400 on an unknown field (strict schema)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { bogus: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 when patching schedule with a valid cron expression', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { schedule: '*/10 * * * *', enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().schedule).toBe('*/10 * * * *')
    expect(res.json().enabled).toBe(false)
  })
})

describe('PATCH /api/skills/:id — editable content (source/name/description)', () => {
  let id: string
  let originalName: string
  beforeAll(async () => {
    const payload = makeSkill({ triggerType: 'manual', description: 'orig desc' })
    originalName = payload.name as string
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload })
    persistedNames.push(originalName)
    id = res.json().id
  })

  it('updates source/name/description and GET reflects it', async () => {
    const newName = `${originalName}-renamed`
    createdNames.push(newName)
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { source: 'a brand new prompt', name: newName, description: 'new desc' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().source).toBe('a brand new prompt')
    expect(res.json().name).toBe(newName)
    expect(res.json().description).toBe('new desc')
    persistedNames.splice(persistedNames.indexOf(originalName), 1)
    persistedNames.push(newName)
    originalName = newName

    // GET reflects the persisted update.
    const list = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH })
    const skill = (list.json() as Array<{ id: string; source: string }>).find(s => s.id === id)
    expect(skill?.source).toBe('a brand new prompt')
  })

  it('400 when patching an over-long source (>2000 chars)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { source: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 when patching an empty source (min 1)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { source: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('partial PATCH (enabled only) does NOT wipe source/name/description', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH })
    const prev = (before.json() as Array<{ id: string; source: string; name: string; description?: string }>).find(s => s.id === id)!

    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().source).toBe(prev.source)
    expect(res.json().name).toBe(prev.name)
    expect(res.json().description).toBe(prev.description)
  })

  it('clearing description to empty string normalizes to absent (NULL → undefined)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { description: '' },
    })
    expect(res.statusCode).toBe(200)
    // '' clears the column to NULL, which rowToSkill maps to undefined — so a
    // cleared description is indistinguishable from one never set.
    expect(res.json().description).toBeUndefined()

    // GET reflects the cleared (absent) description.
    const list = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH })
    const skill = (list.json() as Array<{ id: string; description?: string }>).find(s => s.id === id)
    expect(skill?.description).toBeUndefined()
  })

  it('409 (not 500) when renaming to an existing skill name', async () => {
    // Create a second skill, then try to rename the first onto its name.
    const other = makeSkill({ triggerType: 'manual' })
    const otherRes = await app.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload: other })
    persistedNames.push(other.name as string)
    expect(otherRes.statusCode).toBe(201)

    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { name: other.name },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already exists/i)
  })

  it('200 when "renaming" a skill to its own current name (self-match allowed)', async () => {
    const current = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH })
    const me = (current.json() as Array<{ id: string; name: string }>).find(s => s.id === id)!
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${id}`, headers: AUTH,
      payload: { name: me.name },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe(me.name)
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
