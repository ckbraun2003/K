/**
 * Orchestrators control-plane route test — GET/GET:id/PATCH /api/orchestrators (P5.3a).
 *
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it with
 * app.inject — no socket, no scheduler. DB is isolated via vitest.config.ts K_DATA_DIR
 * (shared file, single-fork serial). Bootstrap is skipped (K_SKIP_BOOTSTRAP), so the
 * test seeds the durable org roster itself, then asserts the roster/detail/patch surface.
 *
 * SEAM proof: a PATCH that mounts an ungranted MCP server makes updateProfile's
 * fail-closed grant guard THROW → the route answers 400 and the row is UNCHANGED
 * (`asserts the profile is not mutated`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb } from '../src/db.js'
import { seedProfiles, getProfile } from '../src/profiles.js'
import type { ChiefOrgLead, OrchestratorRosterPayload, AgentProfile } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const LEAD_IDS = ['lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']
// The eight durable ids seedProfiles() stands up — deleted below so this suite leaves
// the SHARED core-test DB exactly as it found it (mirrors chief-route.test.ts).
const SEED_IDS = ['k-secretary', 'chief', 'default-orchestrator', ...LEAD_IDS]

let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  seedProfiles()
})

afterAll(async () => {
  try {
    for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  } catch { /* ignore */ }
  await app.close()
})

describe('GET /api/orchestrators', () => {
  it('returns the five discipline leads + an activeLeads count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orchestrators', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as OrchestratorRosterPayload

    expect(Array.isArray(body.leads)).toBe(true)
    const ids = body.leads.map(l => l.profile.id)
    for (const id of LEAD_IDS) expect(ids).toContain(id)
    // No non-lead leaks into the roster.
    expect(ids).not.toContain('default-orchestrator')
    expect(ids).not.toContain('chief')

    // Freshly seeded here → idle and slim. recent-health is always attached with
    // internally-consistent REAL counts (a prior suite on the shared DB may have
    // left terminal activation rows, so no absolute-zero assertion — mirrors the
    // kDelegations delta discipline in chief-route.test.ts).
    const fe = body.leads.find(l => l.profile.id === 'lead-frontend')!
    expect(fe.latestRun).toBeNull()
    expect(fe.live).toBe(false)
    expect(typeof fe.wakes).toBe('number')
    expect(fe.recent).toBeDefined()
    expect(fe.recent!.succeeded + fe.recent!.failed).toBeLessThanOrEqual(fe.recent!.total)
    expect(typeof body.activeLeads).toBe('number')
    expect(body.activeLeads).toBe(0)
  })

  it('surfaces recent-health counts on BOTH the roster entry and the detail (one authority)', async () => {
    // Delta-based against whatever the shared DB already holds for lead-systems
    // (mirrors the kDelegations honesty test): seed a completed/failed/running mix
    // (run_id null — the recent counts derive from agent_runs.status alone; see
    // recentHealth's note) and assert the counts moved by exactly that mix. The
    // new rows are the newest, so they are inside the 10-row window.
    const rosterRecent = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/orchestrators', headers: AUTH })
      return (res.json() as OrchestratorRosterPayload).leads.find(l => l.profile.id === 'lead-systems')!.recent!
    }
    const before = await rosterRecent()

    const seeded: string[] = []
    const mkActivation = (status: string) => {
      const id = uuid()
      seeded.push(id)
      agentRunsDb.insertAgentRun.run({
        id, profileId: 'lead-systems', runId: null, trigger: 'delegation',
        goal: `recent-health ${status}`, projectId: null, workflowId: null,
        status, createdAt: Date.now(), completedAt: status === 'running' ? null : Date.now(),
      })
    }
    try {
      mkActivation('completed')
      mkActivation('completed')
      mkActivation('failed')
      mkActivation('running')

      // Roster surface — a live 'running' activation counts in total only.
      const after = await rosterRecent()
      expect(after.total).toBe(Math.min(before.total + 4, 10))
      expect(after.succeeded).toBeGreaterThanOrEqual(2)
      expect(after.failed).toBeGreaterThanOrEqual(1)
      // The live row is total-only: succeeded+failed trails total by at least 1.
      expect(after.succeeded + after.failed).toBeLessThanOrEqual(after.total - 1)

      // Detail surface — assembleLead attaches the SAME counts (shared recentHealth).
      const detail = await app.inject({ method: 'GET', url: '/api/orchestrators/lead-systems', headers: AUTH })
      expect((detail.json() as ChiefOrgLead).recent).toEqual(after)
    } finally {
      for (const id of seeded) db.prepare('DELETE FROM agent_runs WHERE id = ?').run(id)
    }
  })
})

describe('GET /api/orchestrators/:id', () => {
  it('404s for a non-lead id (default-orchestrator / chief)', async () => {
    for (const id of ['default-orchestrator', 'chief', 'k-secretary', 'nope']) {
      const res = await app.inject({ method: 'GET', url: `/api/orchestrators/${id}`, headers: AUTH })
      expect(res.statusCode).toBe(404)
      expect((res.json() as { error: string }).error).toBe('not found')
    }
  })

  it('returns a ChiefOrgLead shape for a real lead', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orchestrators/lead-frontend', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const lead = res.json() as ChiefOrgLead
    expect(lead.profile.id).toBe('lead-frontend')
    expect(lead.profile.tier).toBe('orchestrator')
    expect(lead).toHaveProperty('latestRun')
    expect(Array.isArray(lead.events)).toBe(true)
    expect(Array.isArray(lead.wakes)).toBe(true)
  })
})

describe('PATCH /api/orchestrators/:id', () => {
  it('applies a skills patch and the row reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/orchestrators/lead-frontend',
      headers: AUTH,
      payload: { skills: ['x'] },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json() as AgentProfile
    expect(updated.skills).toEqual(['x'])
    // The durable row reflects the patch.
    expect(getProfile('lead-frontend')!.skills).toEqual(['x'])
  })

  it('rejects an empty patch (400) and an unknown lead (404)', async () => {
    const empty = await app.inject({
      method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH, payload: {},
    })
    expect(empty.statusCode).toBe(400)
    const notLead = await app.inject({
      method: 'PATCH', url: '/api/orchestrators/default-orchestrator', headers: AUTH, payload: { skills: ['y'] },
    })
    expect(notLead.statusCode).toBe(404)
  })

  it('rejects a tier/charter patch (400, .strict) — a lead cannot be flipped off its own roster', async () => {
    const before = getProfile('lead-frontend')!.tier
    for (const payload of [{ tier: 'chief' }, { charter: 'chief' }] as const) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH, payload,
      })
      expect(res.statusCode).toBe(400)
    }
    // The tier is untouched, so the lead still resolves through isLead.
    expect(getProfile('lead-frontend')!.tier).toBe(before)
    const stillListed = await app.inject({ method: 'GET', url: '/api/orchestrators', headers: AUTH })
    expect((stillListed.json() as OrchestratorRosterPayload).leads.map(l => l.profile.id)).toContain('lead-frontend')
  })

  it('SEAM: an ungranted MCP mount is rejected 400 and the profile is UNCHANGED', async () => {
    const before = getProfile('lead-frontend')!.mcpServers
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/orchestrators/lead-frontend',
      headers: AUTH,
      payload: { mcpServers: ['some-ungranted-server'] },
    })
    expect(res.statusCode).toBe(400)
    // The grant guard's message is surfaced (never a silent success).
    expect((res.json() as { error: string }).error).toMatch(/does not grant it/)
    // The row did NOT change — updateProfile threw before the UPDATE.
    const after = getProfile('lead-frontend')!.mcpServers
    expect(after).toEqual(before)
    expect(after).not.toContain('some-ungranted-server')
  })
})
