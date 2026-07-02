/**
 * profiles.ts — the DB-backed agent-profile registry (P5.0).
 *
 * Covers the CRUD round-trip (create → get/list → update), the authority
 * resolution wired through createProfile (orchestrator gets coding tools; secretary
 * does not), and the idempotent seed of the eight durable org profiles — including
 * the seam self-check that a seeded profile's mcp_servers equals the tier's real
 * mcp/<tier>.json. Isolated DB via vitest.config.ts K_DATA_DIR (shared file), so the
 * suite cleans up every row it creates.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { db } from '../src/db.js'
import {
  createProfile,
  getProfile,
  getProfileByName,
  listProfiles,
  updateProfile,
  seedProfiles,
  DEFAULT_PROFILE,
} from '../src/profiles.js'

// Durable seed ids the seed test stands up — deleted in afterAll to keep the shared
// DB clean. CRUD tests use `p50-…` prefixed ids/names.
const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

afterAll(() => {
  // This suite creates no agent_runs; any would cascade with their profile anyway
  // (FK ON DELETE CASCADE). Scope the profile deletes to this suite's rows.
  db.prepare(`DELETE FROM agent_profiles WHERE id LIKE 'p50-%'`).run()
  for (const id of SEED_IDS) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
})

describe('createProfile / getProfile — round-trip', () => {
  it('persists an orchestrator profile with resolved authority; charter defaults to tier', () => {
    const p = createProfile({ id: 'p50-orch', name: 'p50-orch', tier: 'orchestrator' })
    expect(p.id).toBe('p50-orch')
    expect(p.tier).toBe('orchestrator')
    expect(p.charter).toBe('orchestrator') // defaulted from tier
    expect(p.defaultModel.length).toBeGreaterThan(0)
    // authority resolved from the orchestrator assets
    expect(p.allowedTools).toContain('Task')
    expect(p.allowedTools).toContain('Bash')
    expect(p.mcpServers.sort()).toEqual(['gitnexus', 'kstore'])
    expect(p.skills).toContain('gitnexus')

    // getProfile returns the SAME parsed shape (JSON columns → string[]).
    const got = getProfile('p50-orch')
    expect(got).toEqual(p)
  })

  it('a secretary profile carries NO coding tools and mounts kstore + logistics', () => {
    const p = createProfile({ id: 'p50-sec', name: 'p50-sec', tier: 'secretary' })
    expect(p.allowedTools).not.toContain('Bash')
    expect(p.allowedTools).not.toContain('Task')
    expect(p.mcpServers).toEqual(['kstore', 'logistics'])
  })

  it('getProfile returns null for an unknown id', () => {
    expect(getProfile('p50-nope')).toBeNull()
  })

  it('rejects an override that mounts an ungranted MCP server (D-034 fail-closed)', () => {
    expect(() =>
      createProfile({
        id: 'p50-bad',
        name: 'p50-bad',
        tier: 'orchestrator',
        mcpServers: ['ghost'], // mounted…
        allowedTools: ['Read'], // …but not granted (no mcp__ghost)
      }),
    ).toThrow(/does not grant it/)
    expect(getProfile('p50-bad')).toBeNull() // threw before any INSERT
  })

  it('listProfiles includes the created rows', () => {
    const names = listProfiles().map(p => p.name)
    expect(names).toContain('p50-orch')
    expect(names).toContain('p50-sec')
  })
})

describe('updateProfile — patch merge', () => {
  it('patches one field and leaves the rest intact', () => {
    const before = getProfile('p50-orch')!
    const updated = updateProfile('p50-orch', { defaultModel: 'claude-opus-4-8' })
    expect(updated!.defaultModel).toBe('claude-opus-4-8')
    expect(updated!.tier).toBe(before.tier)
    expect(updated!.allowedTools).toEqual(before.allowedTools)
  })

  it('returns null for an unknown id', () => {
    expect(updateProfile('p50-nope', { defaultModel: 'x' })).toBeNull()
  })

  it('re-resolves authority when the tier changes, keeping the grant row consistent', () => {
    // p50-sec is secretary. Promote it to orchestrator WITHOUT supplying authority
    // arrays — the row must re-resolve to orchestrator's grant, and charter follows tier.
    const updated = updateProfile('p50-sec', { tier: 'orchestrator' })!
    expect(updated.tier).toBe('orchestrator')
    expect(updated.charter).toBe('orchestrator') // charter follows tier
    expect(updated.allowedTools).toContain('Bash')
    expect(updated.mcpServers.sort()).toEqual(['gitnexus', 'kstore'])
  })
})

describe('seedProfiles — idempotent durable roster', () => {
  it('seeds the eight durable profiles once, then no-ops', () => {
    const first = seedProfiles()
    // K, Chief, orchestrator + 5 leads — unless a prior boot already seeded some.
    expect(first).toEqual(expect.arrayContaining(['K', 'Chief', 'orchestrator', 'Frontend']))
    const second = seedProfiles()
    expect(second).toEqual([]) // idempotent by name

    expect(getProfileByName('K')!.tier).toBe('secretary')
    expect(getProfileByName('Chief')!.tier).toBe('chief')
    expect(getProfileByName('Frontend')!.tier).toBe('orchestrator')

    // The default orchestrator seed aligns with DEFAULT_PROFILE identity.
    const orch = getProfileByName('orchestrator')!
    expect(orch.id).toBe(DEFAULT_PROFILE.id)
    expect(orch.charter).toBe('orchestrator')
  })

  it("seam self-check: K's seeded mcp_servers match mcp/secretary.json", () => {
    // K is secretary tier — the synthesizer would mount exactly mcp/secretary.json
    // (kstore + logistics); the seeded row must carry the same grant.
    expect(getProfileByName('K')!.mcpServers).toEqual(['kstore', 'logistics'])
    // and a lead (orchestrator) carries gitnexus + kstore like mcp/orchestrator.json
    expect(getProfileByName('Backend')!.mcpServers.sort()).toEqual(['gitnexus', 'kstore'])
  })
})
