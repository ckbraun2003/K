import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import type { Artifact } from '@k/shared'
import { api } from '../lib/api'
import SectionEditor from './SectionEditor'

interface Props {
  slug: string
}

/**
 * Make in-document `#anchor` links (a bible's table of contents) resolve WITHIN the
 * srcDoc iframe instead of against the parent SPA (fix F-042).
 *
 * A `srcDoc` + `sandbox` iframe has an opaque origin and (in Chromium) resolves a
 * bare `#frag` click against the PARENT document's URL — so clicking a TOC anchor
 * navigated the iframe to `<spa-url>#frag`, loading the SPA (and its Vite client)
 * cross-origin: origin-null blocked it, blanking the viewer with ~6 CORS errors.
 * Injecting `<base href="about:srcdoc">` pins the document's base to itself, so
 * `#frag` resolves to `about:srcdoc#frag` — the same document — and the browser
 * scrolls to the anchor instead of navigating away. The bible HTML is fully
 * self-contained (inline CSS/JS, no external asset refs), so a base href is safe.
 */
export function withInDocBase(html: string): string {
  if (/<base\b/i.test(html)) return html // already has a base — don't fight the author
  const base = '<base href="about:srcdoc">'
  // Prefer just after <head …>; fall back to after <html …>; else prepend.
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/(<head\b[^>]*>)/i, `$1${base}`)
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/(<html\b[^>]*>)/i, `$1${base}`)
  return base + html
}

export default function DocViewer({ slug }: Props) {
  const [view, setView] = useState<'md' | 'html'>('html')
  const [edit, setEdit] = useState(false)

  const { data: artifact, isLoading } = useQuery<Artifact>({
    queryKey: ['artifact', slug],
    queryFn: () => api.artifacts.get(slug),
    staleTime: 30_000,
  })

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted">Loading…</div>
  }

  if (!artifact) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted">Artifact not found</div>
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-text">{artifact.title}</h2>
          <p className="text-xs text-muted">
            Updated {new Date(artifact.updatedAt).toLocaleString()}
            {artifact.phase ? ` · Phase ${artifact.phase}` : ''}
            {artifact.status ? ` · ${artifact.status}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="doc-edit-toggle"
            aria-pressed={edit}
            onClick={() => setEdit(e => !e)}
            className={`rounded-control border px-3 py-1 text-xs font-medium transition-colors ${
              edit
                ? 'border-accent bg-accent text-on-accent'
                : 'border-border text-muted hover:text-text hover:bg-surface'
            }`}
          >
            Edit
          </button>
          <div className="flex rounded-control overflow-hidden border border-border">
            {(['md', 'html'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  view === v
                    ? 'bg-accent text-bg'
                    : 'text-muted hover:text-text hover:bg-surface'
                }`}
              >
                .{v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {view === 'md' && (
          // FU-5: this project has no @tailwindcss/typography plugin registered
          // (tailwind.config.ts `plugins: []`), so every `prose*` utility below
          // was inert — Tailwind never generated CSS for an unregistered plugin
          // class, and `ui-token-gate.test.ts` doesn't scan for it (bracket/
          // plugin-class syntax, not raw palette/hex). `.doc-markdown` is real,
          // token-CSS (index.css @layer components) that actually renders.
          <div className="doc-markdown px-6 py-5">
            <ReactMarkdown>{artifact.md}</ReactMarkdown>
          </div>
        )}
        {view === 'html' && artifact.html && (
          <iframe
            srcDoc={withInDocBase(artifact.html)}
            className="w-full h-full border-none"
            sandbox="allow-scripts"
            title={artifact.title}
          />
        )}
      </div>

      {/* P4 E-30 — edit-in-place. Mounts only when Edit is on; SectionEditor
          self-hides (renders null) for non-bible artifacts. */}
      {edit && (
        <div className="flex-shrink-0 max-h-[45%] overflow-y-auto bg-surface">
          {/* key by slug so switching artifacts fully remounts the editor — otherwise a
              stale section pick + edited draft could Save into the NEWLY-selected bible. */}
          <SectionEditor key={slug} slug={slug} />
        </div>
      )}
    </div>
  )
}
