// localStorage-backed diff preferences: unified/split mode + per-diff-identity
// viewed-file marks (FE-5). Identity = baseRef..headRef so a re-review of the
// SAME refs restores your progress but a new wave (new headRef) starts clean.
const MODE_KEY = 'k.diff.mode'
const VIEWED_KEY = 'k.diff.viewed'
const MAX_IDENTITIES = 20

export type DiffMode = 'split' | 'unified'

export function getDiffMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === 'unified' ? 'unified' : 'split' } catch { return 'split' }
}
export function setDiffMode(mode: DiffMode): void {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* storage unavailable */ }
}

export function diffIdentity(p: { baseRef: string | null; headRef: string | null }): string {
  return `${p.baseRef ?? 'none'}..${p.headRef ?? 'none'}`
}

type ViewedMap = Record<string, string[]>
function readMap(): ViewedMap {
  try { return JSON.parse(localStorage.getItem(VIEWED_KEY) ?? '{}') as ViewedMap } catch { return {} }
}
function writeMap(m: ViewedMap): void {
  const keys = Object.keys(m)
  if (keys.length > MAX_IDENTITIES) for (const k of keys.slice(0, keys.length - MAX_IDENTITIES)) delete m[k]
  try { localStorage.setItem(VIEWED_KEY, JSON.stringify(m)) } catch { /* storage unavailable */ }
}

export function getViewed(identity: string): Set<string> {
  return new Set(readMap()[identity] ?? [])
}
export function toggleViewed(identity: string, path: string): Set<string> {
  const m = readMap()
  const set = new Set(m[identity] ?? [])
  if (set.has(path)) set.delete(path); else set.add(path)
  m[identity] = [...set]
  writeMap(m)
  return set
}
