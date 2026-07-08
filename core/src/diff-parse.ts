/**
 * Unified-diff parser (P1 E-01). ONE parser normalizes BOTH producers —
 * checkpoint-chain `git diff --no-color -M` and `gh pr diff` — into the shared
 * DiffPayload file entries, so the DiffViewer renders one shape. Pure, no I/O.
 * Defensive: unknown metadata lines are skipped; a payload beyond the byte cap
 * is cut at the last complete file boundary and flagged `truncated`.
 */
import type { DiffFile, DiffHunk } from '@k/shared'

// Cap measured in UTF-16 code units via raw.length (≈ bytes for the ASCII bulk of
// diffs) — a cheap guard against pathological output, not an exact byte count.
export const MAX_DIFF_BYTES = 5 * 1024 * 1024

export function parseUnifiedDiff(raw: string): { files: DiffFile[]; truncated: boolean } {
  let truncated = false
  let text = raw
  if (raw.length > MAX_DIFF_BYTES) {
    truncated = true
    const cut = raw.lastIndexOf('\ndiff --git ', MAX_DIFF_BYTES)
    text = cut > 0 ? raw.slice(0, cut) : raw.slice(0, MAX_DIFF_BYTES)
  }

  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLn = 0
  let newLn = 0

  const push = (): void => {
    if (cur) files.push(cur)
    cur = null
    hunk = null
  }

  for (const rawLine of text.split('\n')) {
    // CRLF-content diffs terminate lines with \r\n — strip the stray \r so
    // DiffLine.text never carries an invisible artifact into the viewer.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('diff --git ')) {
      push()
      // `diff --git a/<old> b/<new>` — git quotes paths containing spaces.
      const m = /^diff --git (?:"a\/(.+?)"|a\/(\S+)) (?:"b\/(.+?)"|b\/(\S+))$/.exec(line)
      const oldPath = m ? (m[1] ?? m[2]) : ''
      const newPath = m ? (m[3] ?? m[4]) : ''
      cur = {
        path: newPath || oldPath,
        oldPath: null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      continue
    }
    if (!cur) continue
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue }
    if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice('rename from '.length); continue }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length); continue }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') { cur.binary = true; continue }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!m) continue
      oldLn = parseInt(m[1], 10)
      newLn = parseInt(m[2], 10)
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue // ---/+++/index/mode metadata between header and first hunk
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLn++ })
      cur.additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLn++, newLine: null })
      cur.deletions++
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLn++, newLine: newLn++ })
    }
    // `\ No newline at end of file` and blank artifacts: skipped
  }
  push()
  return { files, truncated }
}
