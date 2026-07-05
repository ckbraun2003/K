/**
 * PATCH /api/orchestrators/:id with DISCOVERED (qualified-key) grants — Lane A
 * wave A2. The route itself is untouched; updateProfile's widened fail-closed
 * guard (assertEffectiveGrants) is what these lock:
 *
 *   - the bare-name flow is BYTE-IDENTICAL to today (out-of-bundle bare skill
 *     PATCH still 200s — the synth bundle ceiling owns bare names);
 *   - a qualified skill grant 200s when the asset is enabled+ok and the tier
 *     opts in; the row stores the qualified key verbatim;
 *   - a disabled asset → 400 NAMING the asset (the existing GrantError banner);
 *   - disabling an asset fail-closes every LATER patch of the referencing
 *     profile (the plan's invariant) until the grant is removed;
 *   - discovered MCP grants require trust + the mcp__<name> tool grant.
 *
 * App harness mirrors orchestrators-route.test.ts (buildApp + inject, seeds
 * cleaned up afterAll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import { seedProfiles, getProfile } from '../src/profiles.js'
import { resolveAuthority } from '../src/authority.js'
import { canonicalMcpConfigHash } from '../src/host-discovery.js'
import type { AgentProfile } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

let app: FastifyInstance
const seededSkillKeys: string[] = []
const seededMcpKeys: string[] = []

function seedDiscoveredSkill(enabled: 0 | 1): string {
  const name = `patch-skill-${uuid().slice(0, 8)}`
  const key = `user:${name}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, '', 'skill', ?, 'manual', ?, ?, 'claude-user', ?, 'hash', 1, 1, 'ok', ?, ?)`,
  ).run(uuid(), name, `/host/${name}`, enabled, Date.now(), `/host/${name}`, Date.now(), key)
  seededSkillKeys.push(key)
  return key
}

function seedHostMcp(enabled: 0 | 1, trusted: boolean): { key: string; name: string } {
  const name = `patch-srv-${uuid().slice(0, 8)}`
  const key = `user:${name}`
  const hash = canonicalMcpConfigHash('node', [], {})
  db.prepare(
    `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                   config_hash, enabled, trusted_hash, trusted_at, status, discovered_at, last_scanned_at)
     VALUES (?, ?, ?, 'claude-user', NULL, 'node', '[]', '{}', ?, ?, ?, ?, 'ok', ?, ?)`,
  ).run(uuid(), name, key, hash, enabled, trusted ? hash : null, trusted ? Date.now() : null, Date.now(), Date.now())
  seededMcpKeys.push(key)
  return { key, name }
}

const setSkillEnabled = (key: string, enabled: 0 | 1): void => {
  db.prepare(`UPDATE skills SET enabled = ? WHERE qualified_key = ?`).run(enabled, key)
}

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
    for (const key of seededSkillKeys) db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(key)
    for (const key of seededMcpKeys) db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
  } catch { /* ignore */ }
  await app.close()
})

const patchLead = (payload: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/orchestrators/lead-frontend', headers: AUTH, payload: payload as Record<string, unknown> })

describe('PATCH /api/orchestrators/:id — discovered grants (A2)', () => {
  it('bare-name flow is byte-identical: an out-of-bundle bare skill still 200s', async () => {
    const res = await patchLead({ skills: ['x'] })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentProfile).skills).toEqual(['x'])
    // restore
    expect((await patchLead({ skills: [] })).statusCode).toBe(200)
  })

  it('a qualified key for an enabled+ok discovered skill 200s and lands on the row verbatim', async () => {
    const key = seedDiscoveredSkill(1)
    const res = await patchLead({ skills: [key] })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentProfile).skills).toEqual([key])
    expect(getProfile('lead-frontend')!.skills).toEqual([key])

    // The plan's invariant: DISABLING the asset fail-closes the NEXT patch of the
    // referencing profile — even an unrelated one — with an error naming the asset.
    setSkillEnabled(key, 0)
    const blocked = await patchLead({ defaultModel: null })
    expect(blocked.statusCode).toBe(400)
    expect((blocked.json() as { error: string }).error).toContain(key)
    expect((blocked.json() as { error: string }).error).toMatch(/is disabled/)
    // The row is unchanged (updateProfile threw before the UPDATE).
    expect(getProfile('lead-frontend')!.skills).toEqual([key])

    // Removing the grant un-blocks the profile.
    const restored = await patchLead({ skills: [] })
    expect(restored.statusCode).toBe(200)
    expect(getProfile('lead-frontend')!.skills).toEqual([])
  })

  it('a DISABLED discovered skill grant is a 400 naming the asset; the row is unchanged', async () => {
    const before = getProfile('lead-frontend')!.skills
    const key = seedDiscoveredSkill(0)
    const res = await patchLead({ skills: [key] })
    expect(res.statusCode).toBe(400)
    const err = (res.json() as { error: string }).error
    expect(err).toContain(key)
    expect(err).toMatch(/is disabled — enable it in the capability catalog/)
    expect(getProfile('lead-frontend')!.skills).toEqual(before)
  })

  it('an invalid qualified key is a 400 (grammar), not a 500', async () => {
    const res = await patchLead({ skills: ['user:not..safe'] })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/not a valid catalog key/)
  })

  it('a trusted+enabled discovered MCP server mounts when its mcp__<name> grant rides along', async () => {
    const { key, name } = seedHostMcp(1, true)
    const orch = resolveAuthority('orchestrator')
    const res = await patchLead({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json() as AgentProfile
    expect(updated.mcpServers).toContain(key)
    expect(updated.allowedTools).toContain(`mcp__${name}`)
    // restore to tier defaults
    expect((await patchLead({ mcpServers: [], allowedTools: [] })).statusCode).toBe(200)
  })

  it('an UNTRUSTED discovered MCP server is refused 400 naming the asset (enable requires trust, D-070)', async () => {
    const { key, name } = seedHostMcp(1, false)
    const orch = resolveAuthority('orchestrator')
    const res = await patchLead({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(res.statusCode).toBe(400)
    const err = (res.json() as { error: string }).error
    expect(err).toContain(key)
    expect(err).toMatch(/is not trusted/)
  })

  it('a discovered mount WITHOUT its mcp__<name> grant hits the D-034 wording (400)', async () => {
    const { key } = seedHostMcp(1, true)
    const orch = resolveAuthority('orchestrator')
    const res = await patchLead({ mcpServers: [...orch.mcpServers, key] })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/does not grant it/)
  })
})
