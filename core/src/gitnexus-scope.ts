/**
 * gitnexus-scope (P1 W0c) — thin, OFFLINE mapping from changed files to indexed
 * symbols using the project's exported `.gitnexus/graph.json` (written by
 * graph.ts::exportGraphJson). Deliberately no CLI and no MCP in this path: the
 * installed gitnexus CLI has no detect-changes subcommand, and the graph artifact
 * is the already-exported source of truth — so the E-04 post-run verify leg and
 * the E-07 impact panel stay fast and non-blocking. Unindexed projects degrade
 * to indexed:false; a missing/garbled artifact degrades to null.
 */
import fs from 'fs'
import path from 'path'

export interface ScopeGraph {
  nodes: Array<{ id: string; label?: unknown; name?: unknown; type?: unknown; file?: unknown }>
  links: Array<{ source?: unknown; target?: unknown; type?: unknown }>
}
export interface ScopeSymbol { id: string; name: string; type: string | null; dependents: number }
export interface FileScope { file: string; symbols: ScopeSymbol[] }

/** Indexed ⟺ `.gitnexus/meta.json` exists (graph.ts's authoritative sentinel). */
export function isProjectIndexed(localPath: string): boolean {
  return fs.existsSync(path.join(localPath, '.gitnexus', 'meta.json'))
}

/** Defensive read of `.gitnexus/graph.json` → lean graph, or null. Entries
 *  without a string id (nodes) or non-objects (both) are dropped per-entry. */
export function loadGraphJson(localPath: string): ScopeGraph | null {
  try {
    const raw = fs.readFileSync(path.join(localPath, '.gitnexus', 'graph.json'), 'utf8')
    const parsed = JSON.parse(raw) as { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter(
      (n): n is ScopeGraph['nodes'][number] =>
        !!n && typeof n === 'object' && typeof (n as { id?: unknown }).id === 'string',
    )
    const links = ((Array.isArray(parsed.links) ? parsed.links : parsed.edges) ?? []).filter(
      (l): l is ScopeGraph['links'][number] => !!l && typeof l === 'object',
    ) as ScopeGraph['links']
    return { nodes, links }
  } catch {
    return null
  }
}

/** Normalize for matching: forward slashes, lower-case, no leading './'. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** Node files may be absolute or repo-relative — suffix-match both directions. */
export function fileMatches(nodeFile: string, changedFile: string): boolean {
  const a = norm(nodeFile)
  const b = norm(changedFile)
  if (a === b) return true
  return a.endsWith('/' + b) || b.endsWith('/' + a)
}

/** Symbols per changed file, each with its DIRECT dependents count (inbound
 *  graph edges), sorted most-depended-on first. */
export function scopeForFiles(graph: ScopeGraph, changedFiles: string[]): FileScope[] {
  const inbound = new Map<string, number>()
  for (const l of graph.links) {
    if (typeof l.target === 'string') inbound.set(l.target, (inbound.get(l.target) ?? 0) + 1)
  }
  return changedFiles.map(file => {
    const symbols: ScopeSymbol[] = []
    for (const n of graph.nodes) {
      if (typeof n.file !== 'string' || !fileMatches(n.file, file)) continue
      const name =
        typeof n.name === 'string' && n.name !== '' ? n.name
        : typeof n.label === 'string' && n.label !== '' ? n.label
        : n.id
      symbols.push({
        id: n.id, name,
        type: typeof n.type === 'string' ? n.type : null,
        dependents: inbound.get(n.id) ?? 0,
      })
    }
    symbols.sort((a, b) => b.dependents - a.dependents)
    return { file, symbols }
  })
}

/**
 * Structural risk thresholds (E-07 chip): HIGH when any symbol has ≥10 direct
 * dependents or the total blast is ≥25; MEDIUM at ≥3 touched symbols or ≥5
 * total dependents; LOW otherwise; null when nothing matched (or unindexed).
 */
export function riskForScope(files: FileScope[]): 'low' | 'medium' | 'high' | null {
  const symbols = files.flatMap(f => f.symbols)
  if (symbols.length === 0) return null
  const total = symbols.reduce((s, x) => s + x.dependents, 0)
  const maxDeps = Math.max(...symbols.map(s => s.dependents))
  if (maxDeps >= 10 || total >= 25) return 'high'
  if (symbols.length >= 3 || total >= 5) return 'medium'
  return 'low'
}
