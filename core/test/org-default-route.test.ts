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
  it('round-trips a skills change (a real tier-bundle skill); the durable row reflects it', async () => {
    const app = await makeApp()
    try {
      // 'gitnexus' is in the orchestrator tier bundle (the skills ceiling), so it is
      // an accepted org-default skill (F-049 validates against that set).
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { skills: ['gitnexus'] },
      })
      expect(res.statusCode).toBe(200)
      const updated = res.json() as AgentProfile
      expect(updated.skills).toEqual(['gitnexus'])
      expect(getProfile('default-orchestrator')!.skills).toEqual(['gitnexus'])
    } finally {
      await app.close()
    }
  })

  it('400 on a skill outside the tier skill set (F-049); the profile is UNCHANGED', async () => {
    const app = await makeApp()
    try {
      const before = getProfile('default-orchestrator')!.skills
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { skills: ['gitnexus', 'this-skill-does-not-exist'] },
      })
      expect(res.statusCode).toBe(400)
      const err = (res.json() as { error: string }).error
      expect(err).toMatch(/this-skill-does-not-exist/)
      expect(err).toMatch(/skill/)
      // The row did NOT change — validation ran before the UPDATE.
      expect(getProfile('default-orchestrator')!.skills).toEqual(before)
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

  it('400 on an unknown key (.strict) — names the offending field (F-024)', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { bogus: true },
      })
      expect(res.statusCode).toBe(400)
      // The opaque "invalid patch" was replaced with a message naming the offending key.
      expect((res.json() as { error: string }).error).toMatch(/bogus/)
    } finally {
      await app.close()
    }
  })

  it('400 naming tier/charter as immutable when a PATCH tries to move them (F-024)', async () => {
    const app = await makeApp()
    try {
      for (const payload of [{ tier: 'chief' }, { charter: 'secretary' }]) {
        const res = await app.inject({ method: 'PATCH', url: '/api/org-default', payload })
        expect(res.statusCode).toBe(400)
        const err = (res.json() as { error: string }).error
        expect(err).toMatch(/tier|charter/)
        expect(err).toMatch(/immutable/)
      }
      // The profile's tier/charter are untouched.
      expect(getProfile('default-orchestrator')!.tier).toBe('orchestrator')
      expect(getProfile('default-orchestrator')!.charter).toBe('orchestrator')
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

  it('SEAM: an above-ceiling allowedTools patch is rejected 400 (tier ceiling) and the profile is UNCHANGED', async () => {
    const app = await makeApp()
    try {
      const before = getProfile('default-orchestrator')!.allowedTools
      // The dead `Agent` token is above the ceiling at every tier (D-032).
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/org-default',
        payload: { allowedTools: ['Agent'] },
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toMatch(/tier ceiling/)
      expect(getProfile('default-orchestrator')!.allowedTools).toEqual(before)
    } finally {
      await app.close()
    }
  })
})
