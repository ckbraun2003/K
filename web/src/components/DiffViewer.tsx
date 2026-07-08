import { useEffect, useState } from 'react'
import type { DiffFile, DiffLine, ReviewComment } from '@k/shared'
import { cn } from '../lib/cn'
import { alignHunk, commentAnchorKey } from '../lib/review'
import AutoTextarea from './AutoTextarea'

export interface DiffViewerProps {
  files: DiffFile[]
  comments: ReviewComment[]
  readOnly: boolean                      // PR mount: true (no comment affordances)
  onAddComment?: (a: { file: string; line: number | null; side: 'old' | 'new'; body: string }) => void
  onDeleteComment?: (commentId: string) => void
}

/**
 * Side-by-side diff renderer (P1 A3). Old text sits left, new text right — the
 * add/del tones reuse the ToolCall CodeBlock palette. When NOT readOnly, clicking
 * a new-side line number opens an inline composer; existing comments render as
 * compact cards anchored under their diff line.
 */
export default function DiffViewer({ files, comments, readOnly, onAddComment, onDeleteComment }: DiffViewerProps) {
  // A single composer is open at a time, keyed by `${file}:${newLine}`. The
  // draft text lives INSIDE InlineComposer so keystrokes re-render only the
  // composer, never this whole diff tree (quality-review HIGH).
  const [composeAt, setComposeAt] = useState<string | null>(null)

  // Close the composer when its file leaves the visible set (file-tree
  // narrowing) — otherwise it silently reappears when the file returns.
  useEffect(() => {
    if (composeAt !== null && !files.some(f => composeAt.startsWith(`${f.path}:`))) setComposeAt(null)
  }, [files, composeAt])

  return (
    <div data-testid="diff-viewer" className="text-xs">
      {files.map(file => {
        const fileComments = comments.filter(c => c.file === file.path)
        const byKey = new Map<string, ReviewComment[]>()
        const fileLevel: ReviewComment[] = []
        for (const c of fileComments) {
          if (c.line == null) { fileLevel.push(c); continue }
          const k = commentAnchorKey(c.file, c.line, c.side)
          byKey.set(k, [...(byKey.get(k) ?? []), c])
        }

        const renderCards = (list: ReviewComment[]): React.ReactNode =>
          list.map(c => (
            <div
              key={c.id}
              data-testid={`diff-comment-${c.id}`}
              className="mx-3 my-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <p className="flex-1 whitespace-pre-wrap break-words text-[var(--text)]">{c.body}</p>
                {!readOnly && (
                  <button
                    data-testid={`diff-comment-delete-${c.id}`}
                    onClick={() => onDeleteComment?.(c.id)}
                    aria-label="Delete comment"
                    className="flex-shrink-0 text-[var(--muted)] transition-colors hover:text-[var(--red)]"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))

        return (
          <section key={file.path} className="border-b border-[var(--border)]">
            {/* Sticky file header: path (rename arrow) + per-file counts */}
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--raised)] px-3 py-1.5 border-b border-[var(--border)]">
              <span className="flex-1 truncate font-mono text-[var(--text)]">
                {file.oldPath && file.oldPath !== file.path
                  ? <><span className="text-[var(--muted)]">{file.oldPath}</span> → {file.path}</>
                  : file.path}
              </span>
              <span className="flex-shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {file.status}
              </span>
              <span className="flex-shrink-0 font-mono text-[10px]">
                <span className="text-[var(--green)]">+{file.additions}</span> <span className="text-[var(--red)]">−{file.deletions}</span>
              </span>
            </div>

            {/* File-level comments render above the diff body */}
            {fileLevel.length > 0 && <div className="py-1">{renderCards(fileLevel)}</div>}

            {file.binary ? (
              <div className="px-3 py-2 text-[var(--muted)]">Binary file</div>
            ) : (
              <div className="overflow-x-auto">
                {file.hunks.map((hunk, hi) => (
                  <div key={hi} className="min-w-max">
                    <div className="bg-[var(--surface)] px-3 py-0.5 font-mono text-[10px] text-[var(--muted)]">{hunk.header}</div>
                    {alignHunk(hunk).map((row, ri) => {
                      const key = row.right?.newLine != null ? `${file.path}:${row.right.newLine}` : null
                      const rowComments = [
                        ...(row.right?.newLine != null ? byKey.get(commentAnchorKey(file.path, row.right.newLine, 'new')) ?? [] : []),
                        ...(row.left?.oldLine != null ? byKey.get(commentAnchorKey(file.path, row.left.oldLine, 'old')) ?? [] : []),
                      ]
                      return (
                        <div key={ri}>
                          <div className="grid grid-cols-2">
                            <DiffCell line={row.left} side="left" />
                            <DiffCell
                              line={row.right}
                              side="right"
                              onLineClick={
                                !readOnly && row.right?.newLine != null
                                  ? () => setComposeAt(key)
                                  : undefined
                              }
                              gutterTestid={
                                !readOnly && row.right?.newLine != null
                                  ? `diff-add-${file.path}:${row.right.newLine}`
                                  : undefined
                              }
                            />
                          </div>
                          {rowComments.length > 0 && <div className="py-1">{renderCards(rowComments)}</div>}
                          {key !== null && composeAt === key && (
                            <InlineComposer
                              onSubmit={text => {
                                onAddComment?.({ file: file.path, line: row.right!.newLine!, side: 'new', body: text })
                                setComposeAt(null)
                              }}
                              onCancel={() => setComposeAt(null)}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/**
 * Inline comment composer. Owns its draft text so keystrokes re-render ONLY
 * this component — not the surrounding diff tree (quality-review HIGH).
 */
function InlineComposer({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState('')
  const submit = (): void => {
    const text = draft.trim()
    if (text.length === 0) return
    onSubmit(text)
  }
  return (
    <div className="mx-3 my-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
      <AutoTextarea
        data-testid="diff-comment-body"
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Leave a review comment…"
        className="w-full resize-none bg-transparent font-sans text-xs text-[var(--text)] placeholder-[var(--muted)] focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          data-testid="diff-comment-cancel"
          onClick={onCancel}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
        >
          Cancel
        </button>
        <button
          data-testid="diff-comment-submit"
          onClick={submit}
          disabled={draft.trim().length === 0}
          className="rounded bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  )
}

/** One side of an aligned row: line-number gutter + code cell, toned by kind. */
function DiffCell({
  line,
  side,
  onLineClick,
  gutterTestid,
}: {
  line: DiffLine | null
  side: 'left' | 'right'
  onLineClick?: () => void
  gutterTestid?: string
}) {
  const num = line == null ? null : side === 'left' ? line.oldLine : line.newLine
  const toneAdd = side === 'right' && line?.kind === 'add'
  const toneDel = side === 'left' && line?.kind === 'del'
  return (
    <div
      className={cn(
        'flex min-w-0 font-mono',
        line == null && 'bg-black/20',
        toneAdd && 'bg-green/10 text-[var(--green)]',
        toneDel && 'bg-red/10 text-[var(--red)]',
        line != null && !toneAdd && !toneDel && 'text-[var(--text)]',
      )}
    >
      {onLineClick ? (
        <button
          data-testid={gutterTestid}
          onClick={onLineClick}
          title="Add a comment"
          aria-label={`Add a comment on line ${num}`}
          className="w-12 flex-shrink-0 select-none border-r border-[var(--border)] px-2 text-right text-[10px] text-[var(--muted)] transition-colors hover:bg-[var(--accent)]/20 hover:text-[var(--text)]"
        >
          {num ?? ''}
        </button>
      ) : (
        <span className="w-12 flex-shrink-0 select-none border-r border-[var(--border)] px-2 text-right text-[10px] text-[var(--muted)]">
          {num ?? ''}
        </span>
      )}
      <span className="whitespace-pre px-2 py-px">{line == null ? '' : line.text}</span>
    </div>
  )
}
