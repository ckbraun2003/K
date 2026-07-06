import type { CatalogSkill, SkillSourceKind, ModelCompat } from '@k/shared'

// Pure filter for the CatalogTab's skill list — one testable place for the
// facet semantics so the page component stays declarative.

export interface CatalogFilter {
  /** Keep only this provenance ('k' | 'claude-user' | 'claude-project' | 'claude-plugin'). */
  sourceKind?: SkillSourceKind
  /** Keep only entries whose K-scoped overlay is ON. */
  enabledOnly?: boolean
  /** Keep only this model-compat class. */
  compat?: ModelCompat
  /** Case-insensitive substring over name, description, id (qualified key) and
   *  pluginName. Whitespace-only ≡ no text filter. */
  q?: string
}

/** Apply every set facet (AND semantics). An empty/omitted filter is identity. */
export function filterCatalog(
  skills: ReadonlyArray<CatalogSkill>,
  filter: CatalogFilter = {},
): CatalogSkill[] {
  const q = filter.q?.trim().toLowerCase()
  return skills.filter(s => {
    if (filter.sourceKind !== undefined && s.sourceKind !== filter.sourceKind) return false
    if (filter.enabledOnly === true && !s.enabled) return false
    if (filter.compat !== undefined && s.modelCompat !== filter.compat) return false
    if (q !== undefined && q !== '') {
      const haystack = [s.name, s.description ?? '', s.id, s.pluginName ?? '']
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}
