// web/src/help/HelpGuide.tsx
// FE-6 — the in-app user guide: a glass-overlay Radix dialog (~880px), left
// page rail + prev/next + ArrowLeft/ArrowRight. Radix supplies focus trap,
// Esc-close and aria wiring (Dialog.tsx precedent). Content: HELP_PAGES.
import { useState } from 'react'
import * as RD from '@radix-ui/react-dialog'
import { cn } from '../lib/cn'
import { HELP_PAGES } from './pages'
import { Button, IconButton } from '../ui/Button'

export default function HelpGuide({ open, onOpenChange }: {
  open: boolean; onOpenChange: (o: boolean) => void
}) {
  const [page, setPage] = useState(0)
  const last = HELP_PAGES.length - 1
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') { e.preventDefault(); setPage(p => Math.min(last, p + 1)) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPage(p => Math.max(0, p - 1)) }
  }
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-bg-deep/60" />
        <RD.Content
          data-testid="help-guide"
          onKeyDown={onKeyDown}
          aria-label="K user guide"
          className="glass-overlay fixed left-1/2 top-1/2 z-50 flex h-[min(640px,85vh)] w-[min(880px,92vw)]
            -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden focus:outline-none"
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <RD.Title className="text-title">How to use K</RD.Title>
            <RD.Close asChild><IconButton variant="ghost" name="close" label="Close guide" /></RD.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <nav aria-label="Guide pages" className="w-56 flex-shrink-0 overflow-y-auto border-r border-border py-2">
              {HELP_PAGES.map((p, i) => (
                <button
                  key={p.id}
                  data-testid={`help-page-${p.id}`}
                  aria-current={i === page ? 'page' : undefined}
                  onClick={() => setPage(i)}
                  className={cn('block w-full px-4 py-2 text-left text-body transition-colors duration-[var(--dur-1)]',
                    i === page ? 'bg-[var(--glass-active)] text-text shadow-[inset_0_0_0_1px_var(--glass-active-edge)]' : 'text-muted hover:text-text')}
                >
                  <span className="mono mr-2 text-micro text-muted">{i + 1}</span>{p.title}
                </button>
              ))}
            </nav>
            <article data-testid="help-body" className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
              {HELP_PAGES[page].body}
            </article>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <Button variant="ghost" size="sm" icon="arrowLeft" disabled={page === 0}
              data-testid="help-prev" onClick={() => setPage(p => Math.max(0, p - 1))}>
              Previous
            </Button>
            <span className="mono text-micro tabular-nums text-muted">{page + 1} / {HELP_PAGES.length}</span>
            <Button variant="ghost" size="sm" disabled={page === last}
              data-testid="help-next" onClick={() => setPage(p => Math.min(last, p + 1))}>
              Next
            </Button>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
