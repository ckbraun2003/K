/**
 * Org-default authority route — GET/PATCH /api/org-default (P5.3b).
 *
 * Registers settingsRoutes on a bare Fastify app (like settings-route.test.ts) so no
 * bootstrap/socket runs. The org-default is the durable `default-orchestrator` profile, so
 * the suite seeds the org roster itself (seedProfiles), asserts GET returns it + PATCH
 * round-trips a skills change + PATCH 400 on an empty body, then cleans up its rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { db } from '../src/db.js'
import { settingsRoutes } from '../src/routes/settings.js'
import { seedProfiles, getProfile } from '../src/profiles.js'
import type { AgentProfile } from '@k/shared'

const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

beforeAll(() => {
  seedProfiles()
})

afterAll(() => {
  for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
})

async function makeApp() {
  const app = Fastify()
  await app.register(settingsRoutes)
  return app
}

describe('GET /api/org-default', () => {
  it('returns the default-orchestrator profile', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/org-default' })
      expect(res.statusCode).toBe(200)
      const profile = res.json() as AgentProfile
      expect(profile.id).toBe('default-orchestrator')
      expect(profile.tier).toBe('orchestrator')
      expect(Array.isArray(profile.allowedTools)).toBe(true)
    } finally {
      await app.close()
    }
  })
})

describe('PATCH /api/org-default', () => {
  it('round-trips a skills change; the durable row reflects it', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { skills: ['org-default-x'] },
      })
      expect(res.statusCode).toBe(200)
      const updated = res.json() as AgentProfile
      expect(updated.skills).toEqual(['org-default-x'])
      expect(getProfile('default-orchestrator')!.skills).toEqual(['org-default-x'])
    } finally {
      await app.close()
    }
  })

  it('400 on an empty body', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'PATCH', url: '/api/org-default', payload: {} })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('empty patch')
    } finally {
      await app.close()
    }
  })

  it('400 on an unknown key (.strict)', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { bogus: true },
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('invalid patch')
    } finally {
      await app.close()
    }
  })

  it('SEAM: an ungranted MCP mount is rejected 400 and the profile is UNCHANGED', async () => {
    const app = await makeApp()
    try {
      const before = getProfile('default-orchestrator')!.mcpServers
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { mcpServers: ['some-ungranted-server'] },
      })
      expect(res.statusCode).toBe(400)
      // The grant guard's message is surfaced (never a silent success).
      expect((res.json() as { error: string }).error).toMatch(/does not grant it/)
      // The row did NOT change — updateProfile threw before the UPDATE.
      const after = getProfile('default-orchestrator')!.mcpServers
      expect(after).toEqual(before)
      expect(after).not.toContain('some-ungranted-server')
    } finally {
      await app.close()
    }
  })
})
