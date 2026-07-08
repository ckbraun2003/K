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

afterEach(() => cleanup())

describe('DiffViewer', () => {
  it('renders old (left/del) and new (right/add) texts side-by-side; ctx spans both', () => {
    render(<DiffViewer files={[MODIFY]} comments={[]} readOnly />)
    expect(screen.getByText('old line')).toBeTruthy()
    expect(screen.getByText('new line')).toBeTruthy()
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
})
