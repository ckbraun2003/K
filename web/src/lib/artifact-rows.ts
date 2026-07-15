/** DF-5 — the Docs rail showed two identical "K — Project Bible" rows (legacy
 *  harness `project-bible` + per-project `project-<id>-bible`). BE-3 may
 *  dedupe at source; this display helper stays defensive either way: rows
 *  whose TITLES collide get their slug appended so every row is identifiable.
 *  Pure + unit-tested; a no-op when titles are unique. */
export interface RailRow { slug: string; title: string; tags: string[]; updatedAt: number }

export function disambiguateRailRows<T extends RailRow>(rows: T[]): Array<T & { railLabel: string }> {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.title, (counts.get(r.title) ?? 0) + 1)
  return rows.map(r => ({ ...r, railLabel: (counts.get(r.title) ?? 0) > 1 ? `${r.title} · ${r.slug}` : r.title }))
}
