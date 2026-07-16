/** P1 A3 — DiffViewer: side-by-side render, inline composer, anchored comment cards. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { DiffFile, ReviewComment } from '@k/shared'
import DiffViewer from '../src/components/DiffViewer'

const MODIFY: DiffFile = {
  path: 'src/a.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'ctx', text: 'keep', oldLine: 1, newLine: 1 },
        { kind: 'del', text: 'old line', oldLine: 2, newLine: null },
        { kind: 'add', text: 'new line', oldLine: null, newLine: 2 },
      ],
    },
  ],
}

const BINARY: DiffFile = {
  path: 'img.png', oldPath: null, status: 'modified', binary: true, additions: 0, deletions: 0, hunks: [],
}

// v2 fixtures. NOTE: the brief cited `test/fixtures/impressive-wave/diff-payload.json`
// (a `src/lib/math.ts` entry) for these probes, but that fixture (confirmed via
// Grep) only carries format.ts/ReportPage.tsx/old-report.ts/InsightsPage.tsx/
// logo.png — no math.ts, and none of its paired del/add rows produce the
// literal " + 0" span the word-diff test needs. Local literal fixtures (the
// same pattern MODIFY/BINARY above already use) exercise the identical
// behavior deterministically.
const WORD_DIFF: DiffFile = {
  path: 'src/lib/math.ts', oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 1,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      lines: [
        { kind: 'del', text: '  return a + b', oldLine: 1, newLine: null },
        { kind: 'add', text: '  return a + b + 0', oldLine: null, newLine: 1 },
      ],
    },
  ],
}

const TS_LINE: DiffFile = {
  path: 'src/lib/util.ts', oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 0,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      lines: [{ kind: 'ctx', text: 'export function add(a: number, b: number) {', oldLine: 1, newLine: 1 }],
    },
  ],
}

afterEach(() => cleanup())

describe('DiffViewer', () => {
  it('renders old (left/del) and new (right/add) texts side-by-side; ctx spans both', () => {
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly />)
    // "old line"/"new line" is now a word-diff paired row (v2), so its text is
    // split across per-word spans — assert on the container's full text
    // (recurses through descendants) rather than a single-node getByText.
    const text = screen.getByTestId('diff-viewer').textContent ?? ''
    expect(text).toContain('old line')
    expect(text).toContain('new line')
    // ctx text is mirrored into both columns.
    expect(screen.getAllByText('keep').length).toBe(2)
  })

  it('renders a Binary file chip for binary files (no hunks)', () => {
    render(<DiffViewer files={[BINARY]} comments={[]} readOnly />)
    expect(screen.getByText('Binary file')).toBeTruthy()
  })

  it('readOnly hides comment affordances (no clickable gutter)', () => {
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly />)
    expect(screen.queryByTestId('diff-add-src/a.ts:2')).toBeNull()
  })

  it('opens an inline composer on new-side line click and submits onAddComment', () => {
    const onAddComment = vi.fn()
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly={false} onAddComment={onAddComment} />)
    // No composer until a gutter is clicked.
    expect(screen.queryByTestId('diff-comment-body')).toBeNull()
    fireEvent.click(screen.getByTestId('diff-add-src/a.ts:2'))
    const body = screen.getByTestId('diff-comment-body') as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: 'looks good' } })
    fireEvent.click(screen.getByTestId('diff-comment-submit'))
    expect(onAddComment).toHaveBeenCalledWith({ file: 'src/a.ts', line: 2, side: 'new', body: 'looks good' })
  })

  it('renders an existing comment card under its anchor with a delete affordance', () => {
    const comment: ReviewComment = {
      id: 'c1', runId: 'r1', file: 'src/a.ts', line: 2, side: 'new',
      body: 'please rename', status: 'draft', createdAt: 0,
    }
    const onDeleteComment = vi.fn()
    render(<DiffViewer files={[MODIFY]} comments={[comment]} readOnly={false} onDeleteComment={onDeleteComment} />)
    expect(screen.getByTestId('diff-comment-c1')).toBeTruthy()
    expect(screen.getByText('please rename')).toBeTruthy()
    fireEvent.click(screen.getByTestId('diff-comment-delete-c1'))
    expect(onDeleteComment).toHaveBeenCalledWith('c1')
  })

  it('shows renamed path in the header (oldPath → path)', () => {
    const renamed: DiffFile = { ...MODIFY, path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }
    render(<DiffViewer files={[renamed]} comments={[]} readOnly />)
    expect(screen.getByText(/src\/old\.ts/)).toBeTruthy()
    expect(screen.getByText(/src\/new\.ts/)).toBeTruthy()
  })

  it('mode="unified" renders old text before new text in document order', () => {
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly mode="unified" />)
    const text = screen.getByTestId('diff-viewer').textContent ?? ''
    expect(text.indexOf('old line')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('new line')).toBeGreaterThan(text.indexOf('old line'))
  })

  it('viewed files collapse their body but keep the header visible', () => {
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly viewed={new Set(['src/a.ts'])} />)
    expect(screen.getByText(/Marked viewed/)).toBeTruthy()
    expect(screen.queryByText('keep')).toBeNull()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('calls onExpandFile with the file path when "Expand context" is clicked', () => {
    const onExpandFile = vi.fn()
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly onExpandFile={onExpandFile} />)
    fireEvent.click(screen.getByTestId('diff-expand-src/a.ts'))
    expect(onExpandFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('marks the changed word-level span on a paired del/add row (intra-line diff)', () => {
    render(<DiffViewer files={[WORD_DIFF]} comments={[]} readOnly />)
    // newSpans for "  return a + b" -> "  return a + b + 0" is
    // [{unchanged: "  return a + b"}, {changed: " + 0"}] (RTL trims/collapses
    // whitespace for text matching, so the changed span reads as "+ 0").
    const node = screen.getByText('+ 0')
    expect(node.className).toContain('bg-green/25')
  })

  it('syntax-highlights a registered-language line with Prism token classes', async () => {
    render(<DiffViewer files={[TS_LINE]} comments={[]} readOnly />)
    // Highlighting is async (lazy grammar load) — the line starts as plain
    // text and re-renders as per-token spans once typescript.js registers.
    // A ctx line mirrors into both split-mode columns, so "export" appears
    // twice (left + right) — use findAllByText and check every match. The
    // dynamic import can also take longer than RTL's default 1000ms findBy
    // window on a cold module cache, so widen it rather than flake.
    const matches = await screen.findAllByText('export', {}, { timeout: 5000 })
    expect(matches.length).toBeGreaterThan(0)
    for (const kw of matches) {
      expect(kw.className).toContain('token')
      expect(kw.className).toContain('keyword')
    }
  })
})
