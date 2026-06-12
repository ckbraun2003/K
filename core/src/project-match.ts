/** Pure cwd→project inference. Matches when cwd equals or is inside local_path. */
export interface ProjectPathRow { id: string; local_path: string }

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function matchProjectByCwd(cwd: string, projects: ProjectPathRow[]): string | null {
  const c = norm(cwd)
  let best: { id: string; len: number } | null = null
  for (const p of projects) {
    const root = norm(p.local_path)
    if (c === root || c.startsWith(root + '/')) {
      if (!best || root.length > best.len) best = { id: p.id, len: root.length }
    }
  }
  return best?.id ?? null
}
