/** Pure Review Deck helpers (P1 E-01) — no React, unit-tested in node env. */
import type { DiffFile, DiffHunk, DiffLine } from '@k/shared'

export interface AlignedRow { left: DiffLine | null; right: DiffLine | null }

/** Side-by-side alignment: consecutive del/add runs pair index-wise; ctx spans both. */
export function alignHunk(hunk: DiffHunk): AlignedRow[] {
  const rows: AlignedRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []; adds = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line)
    else if (line.kind === 'add') adds.push(line)
    else { flush(); rows.push({ left: line, right: line }) }
  }
  flush()
  return rows
}

/** Flat dir grouping for the file tree aside (root files under dir ''). */
export function groupByDir(files: DiffFile[]): Array<{ dir: string; files: DiffFile[] }> {
  const map = new Map<string, DiffFile[]>()
  for (const f of files) {
    const idx = f.path.lastIndexOf('/')
    const dir = idx === -1 ? '' : f.path.slice(0, idx)
    const arr = map.get(dir) ?? []
    arr.push(f)
    map.set(dir, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, fs]) => ({ dir, files: fs }))
}

/** Stable anchor key for rendering comments under their diff line. */
export function commentAnchorKey(file: string, line: number | null, side: 'old' | 'new'): string {
  return `${file}:${line == null ? 'file' : line}:${side}`
}
