/** The Skill Creator → Catalog highlight handoff (wave C4): save parks the
 *  just-registered skill's catalog id here; CatalogTab consumes it ONCE on
 *  mount and emphasizes that row. sessionStorage (not state) because the
 *  handoff crosses a hash navigation; one-shot so reloads don't re-highlight. */
export const CATALOG_HIGHLIGHT_KEY = 'k.catalog.highlight'
