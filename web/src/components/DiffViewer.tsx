import { useEffect, useState } from 'react'
import type { DiffFile, DiffHunk, DiffLine, ReviewComment } from '@k/shared'
import { cn } from '../lib/cn'
import { alignHunk, commentAnchorKey, intralineDiff, type IntraSpan, type AlignedRow } from '../lib/review'
import { langForPath, ensureLangs, highlightLine, type HastNode } from '../lib/highlight'
import AutoTextarea from './AutoTextarea'
import { Button, IconButton } from '../ui/Button'
import { Checkbox } from '../ui/Field'

export interface DiffViewerProps {
  files: DiffFile[]
  comments: ReviewComment[]
  readOnly: boolean                      // PR mount: true (no comment affordances)
  onAddComment?: (a: { file: string; line: number | null; side: 'old' | 'new'; body: string }) => void
  onDeleteComment?: (commentId: string) => void
  /** v2 — 'split' (default, the P1 side-by-side layout) or 'unified'. */
  mode?: 'split' | 'unified'
  /** v2 — viewed-file paths; header checkbox + collapsed body when viewed. */
  viewed?: Set<string>
  onToggleViewed?: (path: string) => void
  /** v2 — renders "Expand context" per file header (runs only; IN-7). */
  onExpandFile?: (path: string) => void
}

/**
 * Side-by-side (or unified) diff renderer (P1 A3 + FE-5 v2). Old text sits
 * left, new text right in split mode — the add/del tones reuse the ToolCall
 * CodeBlock palette. When NOT readOnly, clicking a new-side line number opens
 * an inline composer; existing comments render as compact cards anchored
 * under their diff line. v2 adds per-line syntax highlighting, word-level
 * intra-line change marks, viewed-file collapse, and per-file expand-context.
 */
export default function DiffViewer({
  files, comments, readOnly, onAddComment, onDeleteComment,
  mode = 'split', viewed, onToggleViewed, onExpandFile,
}: DiffViewerProps) {
  // A single composer is open at a time, keyed by `${file}:${newLine}`. The
  // draft text lives INSIDE InlineComposer so keystrokes re-render only the
  // composer, never this whole diff tree (quality-review HIGH).
  const [composeAt, setComposeAt] = useState<string | null>(null)

  // Close the composer when its file leaves the visible set (file-tree
  // narrowing) — otherwise it silently reappears when the file returns.
  useEffect(() => {
    if (composeAt !== null && !files.some(f => composeAt.startsWith(`${f.path}:`))) setComposeAt(null)
  }, [files, composeAt])

  // Lazily load a grammar per distinct language among the visible files, then
  // bump a tick so CodeText's next render picks up the now-registered
  // language (highlightLine falls back to plain text until then — zero
  // regression path, never blocks the diff from rendering).
  // Not read directly — bumping it forces a re-render once a lazily-loaded
  // grammar registers, so CodeText's next render picks up highlightLine's
  // now-highlighted result (it falls back to plain text until then).
  const [, setLangTick] = useState(0)
  useEffect(() => {
    const langs = [...new Set(files.map(f => langForPath(f.path)).filter((l): l is string => !!l))]
    if (langs.length === 0) return
    let cancelled = false
    void ensureLangs(langs).then(() => { if (!cancelled) setLangTick(t => t + 1) })
    return () => { cancelled = true }
  }, [files])

  return (
    // `code-viewer` scopes W0's --code-* token colors (index.css) onto the
    // Prism/refractor `token <type>` class names CodeText renders below.
    <div data-testid="diff-viewer" className="code-viewer text-xs">
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
              className="mx-3 my-1 rounded-lg border border-border bg-surface px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <p className="flex-1 whitespace-pre-wrap break-words text-text">{c.body}</p>
                {!readOnly && (
                  <IconButton
                    name="close"
                    variant="ghost"
                    size="sm"
                    data-testid={`diff-comment-delete-${c.id}`}
                    onClick={() => onDeleteComment?.(c.id)}
                    label="Delete comment"
                    className="flex-shrink-0 hover:text-red"
                  />
                )}
              </div>
            </div>
          ))

        const lang = langForPath(file.path)
        const isViewed = viewed?.has(file.path) ?? false

        return (
          <section key={file.path} id={`diff-file-${file.path}`} className="border-b border-border">
            {/* Sticky file header: path (rename arrow) + per-file counts + v2 controls */}
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-raised px-3 py-1.5 border-b border-border">
              <span className="flex-1 truncate font-mono text-text">
                {file.oldPath && file.oldPath !== file.path
                  ? <><span className="text-muted">{file.oldPath}</span> → {file.path}</>
                  : file.path}
              </span>
              <span className="flex-shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {file.status}
              </span>
              <span className="flex-shrink-0 font-mono text-[10px]">
                <span className="text-green">+{file.additions}</span> <span className="text-red">−{file.deletions}</span>
              </span>
              {onToggleViewed && (
                <label className="flex flex-shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted">
                  <Checkbox
                    checked={isViewed}
                    onChange={() => onToggleViewed(file.path)}
                    className="h-3 w-3"
                    data-testid={`diff-viewed-${file.path}`}
                  />
                  viewed
                </label>
              )}
              <IconButton
                name="copy"
                label="Copy path"
                variant="ghost"
                size="sm"
                className="flex-shrink-0"
                onClick={() => void navigator.clipboard?.writeText(file.path)}
              />
              {onExpandFile && !file.binary && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`diff-expand-${file.path}`}
                  onClick={() => onExpandFile(file.path)}
                  className="flex-shrink-0"
                >
                  Expand context
                </Button>
              )}
            </div>

            {/* File-level comments render above the diff body */}
            {fileLevel.length > 0 && <div className="py-1">{renderCards(fileLevel)}</div>}

            {file.binary ? (
              <div className="px-3 py-2 text-muted">Binary file</div>
            ) : isViewed ? (
              <p className="px-3 py-1.5 text-[10px] text-muted">Marked viewed — body collapsed.</p>
            ) : (
              <div className="overflow-x-auto">
                {file.hunks.map((hunk, hi) => (
                  <DiffHunkBlock
                    key={hi}
                    hunk={hunk}
                    filePath={file.path}
                    lang={lang}
                    mode={mode}
                    readOnly={readOnly}
                    byKey={byKey}
                    renderCards={renderCards}
                    composeAt={composeAt}
                    setComposeAt={setComposeAt}
                    onAddComment={onAddComment}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** One hunk, in split or unified layout. A dedicated component (rather than
 *  inlining the per-hunk work into the parent's .map()) so intra-line-diff
 *  computation stays a plain function call in render — no useMemo/hooks
 *  inside a loop, which would vary its call count across renders whenever
 *  file.hunks.length changes. */
function DiffHunkBlock({
  hunk, filePath, lang, mode, readOnly, byKey, renderCards, composeAt, setComposeAt, onAddComment,
}: {
  hunk: DiffHunk
  filePath: string
  lang: string | null
  mode: 'split' | 'unified'
  readOnly: boolean
  byKey: Map<string, ReviewComment[]>
  renderCards: (list: ReviewComment[]) => React.ReactNode
  composeAt: string | null
  setComposeAt: (v: string | null) => void
  onAddComment?: (a: { file: string; line: number | null; side: 'old' | 'new'; body: string }) => void
}) {
  const rows = alignHunk(hunk)
  const pairs = pairSpansFor(rows)

  const commentsFor = (row: AlignedRow): ReviewComment[] => [
    ...(row.right?.newLine != null ? byKey.get(commentAnchorKey(filePath, row.right.newLine, 'new')) ?? [] : []),
    ...(row.left?.oldLine != null ? byKey.get(commentAnchorKey(filePath, row.left.oldLine, 'old')) ?? [] : []),
  ]

  return (
    <div className="min-w-max">
      <div className="bg-surface px-3 py-0.5 font-mono text-[10px] text-muted">{hunk.header}</div>
      {rows.map((row, ri) => {
        const key = row.right?.newLine != null ? `${filePath}:${row.right.newLine}` : null
        const rowComments = commentsFor(row)
        const spans = pairs.get(ri)
        const composer = key !== null && composeAt === key && (
          <InlineComposer
            onSubmit={text => {
              onAddComment?.({ file: filePath, line: row.right!.newLine!, side: 'new', body: text })
              setComposeAt(null)
            }}
            onCancel={() => setComposeAt(null)}
          />
        )

        if (mode === 'unified') {
          return (
            <div key={ri}>
              {row.left && row.right && row.left === row.right ? (
                // ctx row — one shared line
                <UnifiedLine line={row.left} lang={lang} tone={null} />
              ) : (
                <>
                  {row.left && <UnifiedLine line={row.left} lang={lang} tone="del" spans={spans?.old} />}
                  {row.right && (
                    <UnifiedLine
                      line={row.right}
                      lang={lang}
                      tone="add"
                      spans={spans?.new}
                      onLineClick={!readOnly ? () => setComposeAt(key) : undefined}
                      gutterTestid={!readOnly ? `diff-add-${filePath}:${row.right.newLine}` : undefined}
                    />
                  )}
                </>
              )}
              {rowComments.length > 0 && <div className="py-1">{renderCards(rowComments)}</div>}
              {composer}
            </div>
          )
        }

        return (
          <div key={ri}>
            <div className="grid grid-cols-2">
              <DiffCell line={row.left} side="left" lang={lang} spans={spans?.old} />
              <DiffCell
                line={row.right}
                side="right"
                lang={lang}
                spans={spans?.new}
                onLineClick={!readOnly && row.right?.newLine != null ? () => setComposeAt(key) : undefined}
                gutterTestid={!readOnly && row.right?.newLine != null ? `diff-add-${filePath}:${row.right.newLine}` : undefined}
              />
            </div>
            {rowComments.length > 0 && <div className="py-1">{renderCards(rowComments)}</div>}
            {composer}
          </div>
        )
      })}
    </div>
  )
}

/** Paired del/add rows (true replacements, not ctx) → their word-level
 *  intra-line diff, keyed by row index. A plain function, not a hook — safe
 *  to call once per hunk render regardless of how many hunks there are. */
function pairSpansFor(rows: AlignedRow[]): Map<number, { old: IntraSpan[]; new: IntraSpan[] }> {
  const m = new Map<number, { old: IntraSpan[]; new: IntraSpan[] }>()
  rows.forEach((row, ri) => {
    if (row.left?.kind === 'del' && row.right?.kind === 'add') {
      const d = intralineDiff(row.left.text, row.right.text)
      if (d) m.set(ri, d)
    }
  })
  return m
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
    <div className="mx-3 my-1.5 rounded-lg border border-border bg-surface p-2">
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
        className="w-full resize-none bg-transparent font-sans text-xs text-text placeholder-muted focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-testid="diff-comment-cancel"
          onClick={onCancel}
          className="border border-border"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="diff-comment-submit"
          onClick={submit}
          disabled={draft.trim().length === 0}
        >
          Comment
        </Button>
      </div>
    </div>
  )
}

/** Renders one hast tree (or the plain-string fallback) as React nodes.
 *  Element spans keep refractor's own `token <type>` class names — colored
 *  entirely by W0's `.code-viewer .token.*` CSS (index.css), never inline
 *  styles, so this file never needs to track --code-* token names itself. */
function hastToNodes(nodes: HastNode[], key = 'h'): React.ReactNode[] {
  return nodes.map((n, i) =>
    n.type === 'text' ? n.value : (
      <span key={`${key}-${i}`} className={n.properties?.className?.join(' ')}>
        {hastToNodes(n.children, `${key}-${i}`)}
      </span>
    ))
}

/** Render one code line: intra-line marks win over highlighting on changed
 *  spans (a mark without color shift reads as noise); unmarked lines get
 *  full syntax color. Plain-string fallback keeps pre-highlight behavior
 *  exactly (unregistered language, or grammar not loaded yet). */
function CodeText({ text, lang, spans, tone }: {
  text: string; lang: string | null; spans?: IntraSpan[]; tone: 'add' | 'del' | null
}) {
  if (spans) {
    return (
      <>
        {spans.map((s, i) => (
          <span
            key={i}
            className={cn(s.changed && tone === 'add' && 'rounded-sm bg-green/25',
              s.changed && tone === 'del' && 'rounded-sm bg-red/25')}
          >
            {s.text}
          </span>
        ))}
      </>
    )
  }
  const h = highlightLine(text, lang)
  return typeof h === 'string' ? <>{h}</> : <>{hastToNodes(h)}</>
}

/** One side of an aligned row (split mode): line-number gutter + code cell, toned by kind. */
function DiffCell({
  line,
  side,
  lang,
  spans,
  onLineClick,
  gutterTestid,
}: {
  line: DiffLine | null
  side: 'left' | 'right'
  lang: string | null
  spans?: IntraSpan[]
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
        line == null && 'bg-bg/40',
        toneAdd && 'bg-green/10 text-green',
        toneDel && 'bg-red/10 text-red',
        line != null && !toneAdd && !toneDel && 'text-text',
      )}
    >
      {onLineClick ? (
        <button
          data-testid={gutterTestid}
          onClick={onLineClick}
          title="Add a comment"
          aria-label={`Add a comment on line ${num}`}
          className="w-12 flex-shrink-0 select-none border-r border-border px-2 text-right text-[10px] text-muted transition-colors hover:bg-accent/20 hover:text-text"
        >
          {num ?? ''}
        </button>
      ) : (
        <span className="w-12 flex-shrink-0 select-none border-r border-border px-2 text-right text-[10px] text-muted">
          {num ?? ''}
        </span>
      )}
      <span className="whitespace-pre px-2 py-px">
        {line == null ? '' : <CodeText text={line.text} lang={lang} spans={spans} tone={toneAdd ? 'add' : toneDel ? 'del' : null} />}
      </span>
    </div>
  )
}

/** One full-width row (unified mode): dual old/new gutters + code cell, toned by kind. */
function UnifiedLine({
  line, lang, spans, tone, onLineClick, gutterTestid,
}: {
  line: DiffLine
  lang: string | null
  spans?: IntraSpan[]
  tone: 'add' | 'del' | null
  onLineClick?: () => void
  gutterTestid?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 font-mono',
        tone === 'add' && 'bg-green/10 text-green',
        tone === 'del' && 'bg-red/10 text-red',
        tone === null && 'text-text',
      )}
    >
      <span className="w-10 flex-shrink-0 select-none border-r border-border px-1.5 text-right text-[10px] text-muted">
        {line.oldLine ?? ''}
      </span>
      {onLineClick ? (
        <button
          data-testid={gutterTestid}
          onClick={onLineClick}
          title="Add a comment"
          aria-label={`Add a comment on line ${line.newLine}`}
          className="w-10 flex-shrink-0 select-none border-r border-border px-1.5 text-right text-[10px] text-muted transition-colors hover:bg-accent/20 hover:text-text"
        >
          {line.newLine ?? ''}
        </button>
      ) : (
        <span className="w-10 flex-shrink-0 select-none border-r border-border px-1.5 text-right text-[10px] text-muted">
          {line.newLine ?? ''}
        </span>
      )}
      <span className="whitespace-pre px-2 py-px">
        <CodeText text={line.text} lang={lang} spans={spans} tone={tone} />
      </span>
    </div>
  )
}
