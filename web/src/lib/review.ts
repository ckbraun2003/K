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

export interface IntraSpan { text: string; changed: boolean }

/** Word-level intra-line diff for a paired del/add row (client LCS on word/
 *  whitespace tokens). Returns null past `cap` chars per side (perf guard —
 *  FE-5 caps at 400) or when the lines are identical. */
export function intralineDiff(oldText: string, newText: string, cap = 400):
  { old: IntraSpan[]; new: IntraSpan[] } | null {
  if (oldText.length > cap || newText.length > cap || oldText === newText) return null
  const tok = (s: string) => s.match(/\s+|\w+|[^\s\w]+/g) ?? []
  const a = tok(oldText); const b = tok(newText)
  const n = a.length; const m = b.length
  // LCS table (token counts are cap-bounded → worst case ~200×200)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const oldSpans: IntraSpan[] = []; const newSpans: IntraSpan[] = []
  const push = (arr: IntraSpan[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1]
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }
  let i = 0; let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(oldSpans, a[i], false); push(newSpans, b[j], false); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(oldSpans, a[i], true); i++ }
    else { push(newSpans, b[j], true); j++ }
  }
  while (i < n) { push(oldSpans, a[i], true); i++ }
  while (j < m) { push(newSpans, b[j], true); j++ }
  return { old: oldSpans, new: newSpans }
}
