/**
 * authority.ts — the D-069/D-070 EFFECTIVE ceiling (Lane A wave A2).
 *
 * Locks:
 *   - resolveAuthority reads the tier opt-in flags STRICTLY (=== true; absent or
 *     truthy-but-wrong → false, fail-closed); shipped assets: orchestrator opts in,
 *     chief/secretary do not;
 *   - resolveEffectiveCeiling admits ONLY enabled+status-ok discovered skills and
 *     enabled+TRUSTED(pin==hash)+ok discovered servers, and ONLY for tiers that
 *     opt in; the allowedTools ceiling widens in LOCKSTEP (mcp__<name> per
 *     admitted server, nothing else);
 *   - assertEffectiveGrants: tier-only grants byte-identical (same pass/throw +
 *     verbatim assertTierCeiling wording); bare skill names NOT validated here
 *     (the synth bundle ceiling owns them, exactly today); qualified keys are
 *     fail-closed with ACTIONABLE GrantErrors naming the asset and the fix;
 *     D-034 extends to discovered mounts (mcp__<NAME> grant required).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import {
  resolveAuthority,
  resolveEffectiveCeiling,
  assertEffectiveGrants,
  GrantError,
} from '../src/authority.js'
import { canonicalMcpConfigHash } from '../src/host-discovery.js'

// ─── seed helpers (direct rows — precise control over enabled/status/trust) ───

const seededSkillKeys: string[] = []
const seededMcpKeys: string[] = []

function seedDiscoveredSkill(opts: { enabled: 0 | 1; status?: 'ok' | 'missing' }): string {
  const name = `ceil-skill-${uuid().slice(0, 8)}`
  const key = `user:${name}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, '', 'skill', ?, 'manual', ?, ?, 'claude-user', ?, 'hash', 1, 1, ?, ?, ?)`,
  ).run(uuid(), name, `/host/${name}`, opts.enabled, Date.now(), `/host/${name}`, opts.status ?? 'ok', Date.now(), key)
  seededSkillKeys.push(key)
  return key
}

function seedHostMcp(opts: {
  enabled: 0 | 1
  trust: 'pinned' | 'none' | 'stale'
  status?: 'ok' | 'missing'
}): { key: string; name: string } {
  const name = `ceil-srv-${uuid().slice(0, 8)}`
  const key = `user:${name}`
  const hash = canonicalMcpConfigHash('node', ['x.js'], {})
  const trustedHash = opts.trust === 'pinned' ? hash : opts.trust === 'stale' ? 'stale-pin' : null
  db.prepare(
    `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                   config_hash, enabled, trusted_hash, trusted_at, status,
                                   discovered_at, last_scanned_at)
     VALUES (?, ?, ?, 'claude-user', NULL, 'node', '["x.js"]', '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), name, key, hash, opts.enabled, trustedHash, trustedHash ? Date.now() : null, opts.status ?? 'ok', Date.now(), Date.now())
  seededMcpKeys.push(key)
  return { key, name }
}

afterAll(() => {
  for (const key of seededSkillKeys) db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(key)
  for (const key of seededMcpKeys) db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
})

// ─── resolveAuthority flags ───────────────────────────────────────────────────

describe('resolveAuthority — allowDiscovered* flags', () => {
  it('shipped assets: orchestrator opts in; chief/secretary do not', () => {
    const orch = resolveAuthority('orchestrator')
    expect(orch.allowDiscoveredSkills).toBe(true)
    expect(orch.allowDiscoveredServers).toBe(true)
    for (const tier of ['chief', 'secretary'] as const) {
      const a = resolveAuthority(tier)
      expect(a.allowDiscoveredSkills).toBe(false)
      expect(a.allowDiscoveredServers).toBe(false)
    }
  })

  it('absent or truthy-but-non-boolean flags read as FALSE (fail-closed, strict === true)', () => {
    const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ceil-assets-'))
    fs.mkdirSync(path.join(assetsDir, 'allowlists'), { recursive: true })
    fs.mkdirSync(path.join(assetsDir, 'mcp'), { recursive: true })
    fs.mkdirSync(path.join(assetsDir, 'bundles'), { recursive: true })
    fs.writeFileSync(path.join(assetsDir, 'allowlists', 'orchestrator.json'), JSON.stringify({ allowedTools: ['Read'] }))
    // No flags at all:
    fs.writeFileSync(path.join(assetsDir, 'mcp', 'orchestrator.json'), JSON.stringify({ mcpServers: {} }))
    fs.writeFileSync(path.join(assetsDir, 'bundles', 'orchestrator.json'), JSON.stringify({ skills: [] }))
    let a = resolveAuthority('orchestrator', { assetsDir })
    expect(a.allowDiscoveredSkills).toBe(false)
    expect(a.allowDiscoveredServers).toBe(false)
    // Truthy-but-wrong values ("yes", 1) must NOT widen:
    fs.writeFileSync(path.join(assetsDir, 'mcp', 'orchestrator.json'), JSON.stringify({ mcpServers: {}, allowDiscoveredServers: 1 }))
    fs.writeFileSync(path.join(assetsDir, 'bundles', 'orchestrator.json'), JSON.stringify({ skills: [], allowDiscoveredSkills: 'yes' }))
    a = resolveAuthority('orchestrator', { assetsDir })
    expect(a.allowDiscoveredSkills).toBe(false)
    expect(a.allowDiscoveredServers).toBe(false)
    fs.rmSync(assetsDir, { recursive: true, force: true })
  })
})

// ─── resolveEffectiveCeiling ──────────────────────────────────────────────────

describe('resolveEffectiveCeiling', () => {
  it('orchestrator admits enabled+ok discovered skills; disabled/missing are excluded', () => {
    const enabled = seedDiscoveredSkill({ enabled: 1 })
    const disabled = seedDiscoveredSkill({ enabled: 0 })
    const missing = seedDiscoveredSkill({ enabled: 1, status: 'missing' })

    const ceiling = resolveEffectiveCeiling('orchestrator')
    expect(ceiling.discoveredSkills.has(enabled)).toBe(true)
    expect(ceiling.discoveredSkills.has(disabled)).toBe(false)
    expect(ceiling.discoveredSkills.has(missing)).toBe(false)
  })

  it('non-opted-in tiers admit NOTHING even when assets are enabled', () => {
    const enabled = seedDiscoveredSkill({ enabled: 1 })
    const { key: srvKey } = seedHostMcp({ enabled: 1, trust: 'pinned' })
    for (const tier of ['chief', 'secretary'] as const) {
      const ceiling = resolveEffectiveCeiling(tier)
      expect(ceiling.discoveredSkills.size).toBe(0)
      expect(ceiling.discoveredServers.size).toBe(0)
      expect(ceiling.discoveredSkills.has(enabled)).toBe(false)
      expect(ceiling.discoveredServers.has(srvKey)).toBe(false)
    }
  })

  it('servers require enabled AND trusted-with-matching-pin AND ok; allowedTools widens in lockstep', () => {
    const good = seedHostMcp({ enabled: 1, trust: 'pinned' })
    const untrusted = seedHostMcp({ enabled: 1, trust: 'none' })
    const stale = seedHostMcp({ enabled: 1, trust: 'stale' })
    const disabled = seedHostMcp({ enabled: 0, trust: 'pinned' })
    const missing = seedHostMcp({ enabled: 1, trust: 'pinned', status: 'missing' })

    const ceiling = resolveEffectiveCeiling('orchestrator')
    expect(ceiling.discoveredServers.get(good.key)).toBe(good.name)
    for (const rejected of [untrusted, stale, disabled, missing]) {
      expect(ceiling.discoveredServers.has(rejected.key)).toBe(false)
      expect(ceiling.allowedTools.has(`mcp__${rejected.name}`)).toBe(false)
    }
    // Lockstep widening: exactly the admitted server's grant token joins the ceiling.
    expect(ceiling.allowedTools.has(`mcp__${good.name}`)).toBe(true)
    // The base tier allowlist is still there, untouched.
    for (const tool of resolveAuthority('orchestrator').allowedTools) {
      expect(ceiling.allowedTools.has(tool)).toBe(true)
    }
  })
})

// ─── assertEffectiveGrants ────────────────────────────────────────────────────

describe('assertEffectiveGrants', () => {
  const orch = resolveAuthority('orchestrator')

  it('pure tier grants pass byte-identically (the pre-D-069 flow)', () => {
    expect(() =>
      assertEffectiveGrants('orchestrator', {
        allowedTools: orch.allowedTools,
        mcpServers: orch.mcpServers,
        skills: orch.skills,
      }),
    ).not.toThrow()
  })

  it('an above-ceiling tool throws the VERBATIM assertTierCeiling wording', () => {
    expect(() =>
      assertEffectiveGrants('secretary', {
        allowedTools: ['Bash'],
        mcpServers: [],
        skills: [],
      }),
    ).toThrow(
      'authority: tool "Bash" exceeds the "secretary" tier ceiling — the tier allowlist is the ceiling; per-profile rows may only narrow within it',
    )
  })

  it('BARE skill names are NOT validated here — the bare-name flow stays byte-identical', () => {
    expect(() =>
      assertEffectiveGrants('orchestrator', {
        allowedTools: orch.allowedTools,
        mcpServers: orch.mcpServers,
        skills: ['definitely-not-in-any-bundle'],
      }),
    ).not.toThrow()
  })

  it('a valid admitted qualified skill passes; disabled/missing/unknown/bad-grammar are GrantErrors naming the asset', () => {
    const enabled = seedDiscoveredSkill({ enabled: 1 })
    const disabled = seedDiscoveredSkill({ enabled: 0 })
    const missing = seedDiscoveredSkill({ enabled: 1, status: 'missing' })
    const base = { allowedTools: orch.allowedTools, mcpServers: orch.mcpServers }

    expect(() => assertEffectiveGrants('orchestrator', { ...base, skills: [enabled] })).not.toThrow()

    const cases: Array<[string, RegExp]> = [
      [disabled, /is disabled — enable it in the capability catalog/],
      [missing, /is missing on the host/],
      ['user:no-such-skill-anywhere', /not in the capability catalog/],
      ['user:bad..segment', /not a valid catalog key/],
    ]
    for (const [key, msg] of cases) {
      try {
        assertEffectiveGrants('orchestrator', { ...base, skills: [key] })
        expect.unreachable(`expected GrantError for ${key}`)
      } catch (e) {
        expect(e).toBeInstanceOf(GrantError)
        expect((e as Error).message).toMatch(msg)
        expect((e as Error).message).toContain(key.includes('..') ? key : key) // the 400 banner names the asset
      }
    }
  })

  it('a tier without the opt-in rejects EVERY qualified skill, even an enabled one', () => {
    const enabled = seedDiscoveredSkill({ enabled: 1 })
    const chief = resolveAuthority('chief')
    expect(() =>
      assertEffectiveGrants('chief', {
        allowedTools: chief.allowedTools,
        mcpServers: chief.mcpServers,
        skills: [enabled],
      }),
    ).toThrow(/does not admit discovered skills/)
  })

  it('discovered MCP: admitted + granted passes; the mcp__<NAME> grant is required (D-034 extended)', () => {
    const { key, name } = seedHostMcp({ enabled: 1, trust: 'pinned' })
    const granted = {
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
      mcpServers: [...orch.mcpServers, key],
      skills: [],
    }
    expect(() => assertEffectiveGrants('orchestrator', granted)).not.toThrow()

    // Same mount WITHOUT the mcp__<name> grant → the D-034 wording, naming the NAME.
    expect(() =>
      assertEffectiveGrants('orchestrator', { ...granted, allowedTools: orch.allowedTools }),
    ).toThrow(/does not grant it/)
  })

  it('untrusted / disabled / non-opted-in discovered MCP grants are actionable GrantErrors', () => {
    const untrusted = seedHostMcp({ enabled: 1, trust: 'none' })
    const disabled = seedHostMcp({ enabled: 0, trust: 'pinned' })
    const base = { allowedTools: orch.allowedTools, skills: [] }

    expect(() =>
      assertEffectiveGrants('orchestrator', { ...base, mcpServers: [untrusted.key] }),
    ).toThrow(/is not trusted — review and trust it/)
    expect(() =>
      assertEffectiveGrants('orchestrator', { ...base, mcpServers: [disabled.key] }),
    ).toThrow(/is disabled — enable it/)

    const pinned = seedHostMcp({ enabled: 1, trust: 'pinned' })
    const chief = resolveAuthority('chief')
    expect(() =>
      assertEffectiveGrants('chief', {
        allowedTools: chief.allowedTools,
        mcpServers: [pinned.key],
        skills: [],
      }),
    ).toThrow(/does not admit discovered MCP servers/)
  })
})
