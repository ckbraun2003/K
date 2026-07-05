import { describe, it, expect } from 'vitest'
import type { CatalogSkill } from '@k/shared'
import { filterCatalog } from '../src/lib/catalog-filter'

/**
 * catalog-filter (wave C1) — the pure facet filter behind the CatalogTab.
 * Facets AND together; the text query is case-insensitive over name,
 * description, qualified key and pluginName.
 */

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id,
    description: null,
    sourceKind: 'k',
    pluginName: null,
    path: 'x/SKILL.md',
    enabled: false,
    estTokens: null,
    estTokensMeta: null,
    modelCompat: 'universal',
    mountedBy: [],
    status: 'ok',
    updatedAt: null,
    ...over,
  }
}

const catalog: CatalogSkill[] = [
  skill({ id: 'deep-research', name: 'deep-research', description: 'multi-source research', enabled: true }),
  skill({ id: 'user:web-audit', name: 'web-audit', sourceKind: 'claude-user', modelCompat: 'claude-only' }),
  skill({
    id: 'plugin:superpowers@obra:brainstorming',
    name: 'brainstorming',
    sourceKind: 'claude-plugin',
    pluginName: 'superpowers',
    enabled: true,
    modelCompat: 'mcp-dependent',
  }),
  skill({ id: 'project:p1:local-notes', name: 'local-notes', sourceKind: 'claude-project' }),
]

describe('filterCatalog', () => {
  it('no filter is identity', () => {
    expect(filterCatalog(catalog)).toEqual(catalog)
    expect(filterCatalog(catalog, {})).toEqual(catalog)
  })

  it('filters by sourceKind', () => {
    expect(filterCatalog(catalog, { sourceKind: 'claude-plugin' }).map(s => s.id)).toEqual([
      'plugin:superpowers@obra:brainstorming',
    ])
    expect(filterCatalog(catalog, { sourceKind: 'k' }).map(s => s.name)).toEqual(['deep-research'])
  })

  it('enabledOnly keeps only overlay-enabled entries', () => {
    expect(filterCatalog(catalog, { enabledOnly: true }).map(s => s.name)).toEqual([
      'deep-research',
      'brainstorming',
    ])
    // false is NOT "disabled only" — it's the facet switched off.
    expect(filterCatalog(catalog, { enabledOnly: false })).toEqual(catalog)
  })

  it('filters by model compat', () => {
    expect(filterCatalog(catalog, { compat: 'claude-only' }).map(s => s.name)).toEqual(['web-audit'])
  })

  it('text query matches name/description/id/pluginName, case-insensitive', () => {
    expect(filterCatalog(catalog, { q: 'RESEARCH' }).map(s => s.name)).toEqual(['deep-research'])
    expect(filterCatalog(catalog, { q: 'multi-source' }).map(s => s.name)).toEqual(['deep-research'])
    // qualified-key match (the project id lives only in the key)
    expect(filterCatalog(catalog, { q: 'project:p1' }).map(s => s.name)).toEqual(['local-notes'])
    // pluginName match
    expect(filterCatalog(catalog, { q: 'superpowers' }).map(s => s.name)).toEqual(['brainstorming'])
  })

  it('whitespace-only query is no text filter', () => {
    expect(filterCatalog(catalog, { q: '   ' })).toEqual(catalog)
  })

  it('facets AND together', () => {
    expect(
      filterCatalog(catalog, { enabledOnly: true, sourceKind: 'claude-plugin', q: 'brain' }).map(s => s.id),
    ).toEqual(['plugin:superpowers@obra:brainstorming'])
    expect(filterCatalog(catalog, { enabledOnly: true, sourceKind: 'claude-user' })).toEqual([])
  })
})
