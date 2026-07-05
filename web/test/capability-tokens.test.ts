import { describe, it, expect } from 'vitest'
import type { CatalogSkill, CatalogMcpServer } from '@k/shared'
import { enabledSkillTokens, enabledMcpTokens, profileSubtotal } from '../src/lib/capability-tokens'

/**
 * capability-tokens (wave C1) — the pure token-accounting lib behind the
 * CapabilityStatRow and the CapabilityPicker footer. Locks the two honesty
 * rules: null estTokens NEVER lands in a sum (counted as unmeasured instead),
 * and profile entries missing from the catalog are excluded + surfaced as
 * notInCatalog rather than silently priced at zero.
 */

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id,
    description: null,
    sourceKind: 'k',
    pluginName: null,
    path: `agent-config/skills/${over.id}/SKILL.md`,
    enabled: true,
    estTokens: null,
    estTokensMeta: null,
    modelCompat: 'universal',
    mountedBy: [],
    status: 'ok',
    updatedAt: null,
    ...over,
  }
}

function server(over: Partial<CatalogMcpServer> & Pick<CatalogMcpServer, 'id'>): CatalogMcpServer {
  return {
    name: over.id,
    sourceKind: 'claude-user',
    pluginName: null,
    transport: 'stdio',
    commandSummary: 'npx some-server',
    trusted: false,
    enabled: false,
    estTokens: null,
    toolCount: null,
    mountedBy: [],
    status: 'ok',
    ...over,
  }
}

describe('enabledSkillTokens', () => {
  it('sums estTokens over ENABLED skills only', () => {
    const skills = [
      skill({ id: 'a', enabled: true, estTokens: 1000 }),
      skill({ id: 'b', enabled: true, estTokens: 250 }),
      skill({ id: 'c', enabled: false, estTokens: 9999 }), // disabled — excluded entirely
    ]
    expect(enabledSkillTokens(skills)).toEqual({ enabledCount: 2, estTokens: 1250, unestimatedCount: 0 })
  })

  it('excludes null estTokens from the sum and counts them as unmeasured', () => {
    const skills = [
      skill({ id: 'a', enabled: true, estTokens: 500 }),
      skill({ id: 'b', enabled: true, estTokens: null }),
      skill({ id: 'c', enabled: true, estTokens: null }),
    ]
    expect(enabledSkillTokens(skills)).toEqual({ enabledCount: 3, estTokens: 500, unestimatedCount: 2 })
  })

  it('is zero-clean on an empty catalog', () => {
    expect(enabledSkillTokens([])).toEqual({ enabledCount: 0, estTokens: 0, unestimatedCount: 0 })
  })
})

describe('enabledMcpTokens', () => {
  it('sums enabled servers, counting unprobed (null) ones as unmeasured', () => {
    const servers = [
      server({ id: 'm1', enabled: true, estTokens: 4000 }),
      server({ id: 'm2', enabled: true, estTokens: null }), // enabled but never probed
      server({ id: 'm3', enabled: false, estTokens: 800 }), // disabled — excluded
    ]
    expect(enabledMcpTokens(servers)).toEqual({ enabledCount: 2, estTokens: 4000, unestimatedCount: 1 })
  })
})

describe('profileSubtotal', () => {
  const catalogSkills = [
    skill({ id: 'deep-research', estTokens: 1200 }),
    skill({ id: 'user:web-audit', sourceKind: 'claude-user', estTokens: null }),
  ]
  const catalogServers = [
    server({ id: 'user:context7', enabled: true, trusted: true, estTokens: 3000 }),
  ]

  it('resolves profile entries against the catalog by qualified key and totals them', () => {
    const sub = profileSubtotal(
      { skills: ['deep-research', 'user:web-audit'], mcpServers: ['user:context7'] },
      catalogSkills,
      catalogServers,
    )
    expect(sub.skills).toEqual({ enabledCount: 2, estTokens: 1200, unestimatedCount: 1 })
    expect(sub.mcp).toEqual({ enabledCount: 1, estTokens: 3000, unestimatedCount: 0 })
    expect(sub.totalEstTokens).toBe(4200)
    expect(sub.unestimatedCount).toBe(1)
    expect(sub.notInCatalog).toEqual([])
  })

  it('excludes not-in-catalog entries from every sum and surfaces them', () => {
    const sub = profileSubtotal(
      { skills: ['deep-research', 'ghost-skill'], mcpServers: ['user:context7', 'ghost-mcp'] },
      catalogSkills,
      catalogServers,
    )
    expect(sub.notInCatalog).toEqual(['ghost-skill', 'ghost-mcp'])
    expect(sub.totalEstTokens).toBe(4200) // ghosts priced at nothing, not zero-summed
    expect(sub.skills.enabledCount).toBe(1)
    expect(sub.mcp.enabledCount).toBe(1)
  })

  it('an empty profile subtotals to zero with no ghosts', () => {
    const sub = profileSubtotal({ skills: [], mcpServers: [] }, catalogSkills, catalogServers)
    expect(sub.totalEstTokens).toBe(0)
    expect(sub.unestimatedCount).toBe(0)
    expect(sub.notInCatalog).toEqual([])
  })
})
