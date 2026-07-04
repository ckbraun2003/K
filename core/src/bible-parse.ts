/** Pure parsing helpers for the bible compiler — no DB, no fs. */

export interface RoadmapPhase { name: string; done: number; total: number }

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

/**
 * Split raw section text into its frontmatter block (INCLUDING the `---` delimiters
 * and the trailing newline) and the body after it. Lossless inverse of concatenation:
 * `frontmatter + body === raw`, and `body` is byte-identical to `parseFrontmatter().body`.
 *
 * Used to write an edited section BODY back to disk while preserving the section's
 * existing frontmatter (title/icon/status/updated) verbatim — never re-serializing it.
 * With no frontmatter, `frontmatter` is '' and `body` is the whole input.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/)
  if (!m) return { frontmatter: '', body: raw }
  return { frontmatter: m[1], body: m[2] }
}

/** Checkbox progress per "## …" heading; headings with zero checkboxes are omitted. */
export function roadmapPhases(sectionMd: string): RoadmapPhase[] {
  const phases: RoadmapPhase[] = []
  let current: RoadmapPhase | null = null
  for (const line of sectionMd.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      current = { name: h[1].replace(/\*/g, ''), done: 0, total: 0 }
      phases.push(current)
      continue
    }
    if (current && /^\s*-\s*\[[ xX]\]/.test(line)) {
      current.total++
      if (/^\s*-\s*\[[xX]\]/.test(line)) current.done++
    }
  }
  return phases.filter(p => p.total > 0)
}
