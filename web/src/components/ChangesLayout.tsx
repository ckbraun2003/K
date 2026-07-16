// FE-5 — the ONE Changes surface serving run review (RunConsole "Changes")
// and PR review (#/pr-review). Left: collapsible dir-grouped file tree with
// per-file ±, viewed ✓. Right: DiffViewer v2. Opaque throughout (dense data).
import { useMemo, useRef, useState } from 'react'
import type { DiffPayload, ReviewComment } from '@k/shared'
import { cn } from '../lib/cn'
import { groupByDir } from '../lib/review'
import { getDiffMode, setDiffMode, diffIdentity, getViewed, toggleViewed, type DiffMode } from '../lib/diff-prefs'
import DiffViewer from './DiffViewer'
import SegControl from './SegControl'
import { Icon } from '../ui/Icon'

export interface ChangesLayoutProps {
  payload: DiffPayload
  comments?: ReviewComment[]
  readOnly: boolean
  onAddComment?: (a: { file: string; line: number | null; side: 'old' | 'new'; body: string }) => void
  onDeleteComment?: (commentId: string) => void
  onExpandFile?: (path: string) => void
}

export default function ChangesLayout({
  payload, comments = [], readOnly, onAddComment, onDeleteComment, onExpandFile,
}: ChangesLayoutProps) {
  const files = payload.files
  const groups = useMemo(() => groupByDir(files), [files])
  const identity = diffIdentity(payload)
  const [mode, setMode] = useState<DiffMode>(getDiffMode)
  const [viewed, setViewed] = useState<Set<string>>(() => getViewed(identity))
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const paneRef = useRef<HTMLDivElement>(null)

  const shown = selected ? files.filter(f => f.path === selected) : files
  // j/k must walk the visibly-rendered (dir-grouped, alpha-sorted) order, not
  // the raw payload's file order — otherwise the "next" file can jump to an
  // unrelated row the tree doesn't show adjacent to the current selection.
  const order = useMemo(() => groups.flatMap(g => g.files.map(f => f.path)), [groups])

  function pickMode(m: DiffMode) { setMode(m); setDiffMode(m) }
  function pickFile(path: string | null) {
    setSelected(path)
    if (path) document.getElementById(`diff-file-${path}`)?.scrollIntoView({ block: 'start' })
  }
  function markViewed(path: string) { setViewed(new Set(toggleViewed(identity, path))) }

  // j/k next/prev file — list semantics, skipped while typing in a field.
  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement
    if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) return
    if (e.key !== 'j' && e.key !== 'k') return
    e.preventDefault()
    const cur = selected ? order.indexOf(selected) : -1
    const next = e.key === 'j' ? Math.min(order.length - 1, cur + 1) : Math.max(0, cur === -1 ? 0 : cur - 1)
    pickFile(order[next] ?? null)
  }

  return (
    <div data-testid="changes-layout" tabIndex={0} onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 outline-none">
      {/* File tree — dense, opaque */}
      <aside data-testid="changes-tree" className="w-64 flex-shrink-0 overflow-y-auto border-r border-border py-2">
        <div className="flex items-center justify-between px-3 pb-2">
          <button onClick={() => pickFile(null)}
            className={cn('text-xs', selected === null ? 'text-text' : 'text-muted hover:text-text')}>
            All files <span className="mono tabular-nums">({files.length})</span>
          </button>
          <SegControl<DiffMode>
            ariaLabel="Diff layout"
            options={[{ label: 'split', value: 'split' }, { label: 'unified', value: 'unified' }]}
            value={mode}
            onChange={pickMode}
          />
        </div>
        {groups.map(g => {
          const dir = g.dir || '(root)'
          const closed = collapsedDirs.has(dir)
          return (
            <div key={dir}>
              <button
                onClick={() => setCollapsedDirs(prev => {
                  const next = new Set(prev)
                  if (next.has(dir)) next.delete(dir); else next.add(dir)
                  return next
                })}
                className="flex w-full items-center gap-1 px-3 pb-0.5 pt-2 text-left"
                aria-expanded={!closed}
              >
                <Icon name="chevronDown" size={14} className={cn('text-muted transition-transform', closed && '-rotate-90')} />
                <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{dir}</span>
              </button>
              {!closed && g.files.map(f => (
                <button
                  key={f.path}
                  data-testid={`changes-file-${f.path}`}
                  aria-current={selected === f.path ? 'true' : undefined}
                  onClick={() => pickFile(f.path)}
                  className={cn('flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs transition-colors',
                    selected === f.path ? 'bg-raised text-text' : 'text-muted hover:text-text')}
                >
                  <span className="min-w-0 flex-1 truncate">{f.path.slice(g.dir ? g.dir.length + 1 : 0)}</span>
                  {viewed.has(f.path) && <span aria-label="viewed" className="text-green">✓</span>}
                  <span className="mono flex-shrink-0 text-[10px]">
                    <span className="text-green">+{f.additions}</span> <span className="text-red">−{f.deletions}</span>
                  </span>
                </button>
              ))}
            </div>
          )
        })}
        <p className="mono px-3 pt-2 text-[10px] text-muted">j/k · next/prev file</p>
      </aside>

      {/* Diff pane */}
      <div ref={paneRef} className="min-w-0 flex-1 overflow-y-auto">
        <DiffViewer
          files={shown}
          comments={comments}
          readOnly={readOnly}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
          mode={mode}
          viewed={viewed}
          onToggleViewed={markViewed}
          onExpandFile={onExpandFile}
        />
      </div>
    </div>
  )
}
