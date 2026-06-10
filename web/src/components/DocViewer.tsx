import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import type { Artifact } from '@k/shared'
import { api } from '../lib/api'

interface Props {
  slug: string
}

export default function DocViewer({ slug }: Props) {
  const [view, setView] = useState<'md' | 'html'>('md')

  const { data: artifact, isLoading } = useQuery<Artifact>({
    queryKey: ['artifact', slug],
    queryFn: () => api.artifacts.get(slug),
    staleTime: 30_000,
  })

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-[var(--muted)]">Loading…</div>
  }

  if (!artifact) {
    return <div className="flex-1 flex items-center justify-center text-[var(--muted)]">Artifact not found</div>
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">{artifact.title}</h2>
          <p className="text-xs text-[var(--muted)]">
            Updated {new Date(artifact.updatedAt).toLocaleString()}
            {artifact.phase ? ` · Phase ${artifact.phase}` : ''}
            {artifact.status ? ` · ${artifact.status}` : ''}
          </p>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-[var(--border)]">
          {(['md', 'html'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                view === v
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]'
              }`}
            >
              .{v}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {view === 'md' && (
          <div className="px-6 py-5 prose prose-invert prose-sm max-w-none
            prose-headings:text-[var(--text)] prose-headings:font-bold
            prose-p:text-[var(--text)] prose-p:leading-relaxed
            prose-a:text-[var(--accent)]
            prose-code:text-purple-300 prose-code:bg-[var(--surface)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
            prose-pre:bg-[var(--surface)] prose-pre:border prose-pre:border-[var(--border)]
            prose-blockquote:border-l-[var(--accent)] prose-blockquote:text-[var(--muted)]
            prose-th:text-[var(--muted)] prose-th:text-xs prose-th:uppercase
            prose-td:text-[var(--text)] prose-td:text-sm
            prose-li:text-[var(--text)]
          ">
            <ReactMarkdown>{artifact.md}</ReactMarkdown>
          </div>
        )}
        {view === 'html' && artifact.html && (
          <iframe
            srcDoc={artifact.html}
            className="w-full h-full border-none"
            sandbox="allow-scripts"
            title={artifact.title}
          />
        )}
      </div>
    </div>
  )
}
