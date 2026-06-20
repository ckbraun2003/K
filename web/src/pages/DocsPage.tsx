import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import DocViewer from '../components/DocViewer'

export default function DocsPage({ slug }: { slug?: string }) {
  const { data: artifacts = [] } = useQuery<Omit<Artifact, 'md' | 'html'>[]>({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })
  const active = slug ?? 'project-bible'

  return (
    <div className="flex h-full">
      <aside className="w-64 flex-shrink-0 overflow-y-auto border-r border-[var(--border)]">
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Artifacts</h2>
        </div>
        {artifacts.map(a => (
          <button
            key={a.slug}
            onClick={() => navigate('docs', a.slug)}
            className={cn(
              'block w-full border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--surface)]',
              active === a.slug && 'border-l-2 border-l-[var(--accent)] bg-[var(--surface)]'
            )}
          >
            <span className="block truncate text-sm text-[var(--text)]">{a.title}</span>
            <span className="mono text-[10px] text-[var(--muted)]">
              {new Date(a.updatedAt).toLocaleDateString()}
              {a.tags.includes('bible') && ' · 📖 bible'}
              {(a.tags.includes('ui') || a.tags.includes('demo')) && ' · 🖥 ui'}
            </span>
          </button>
        ))}
      </aside>
      {/* section, not main — the shell already provides the page's <main> landmark */}
      <section className="flex-1 overflow-hidden">
        <DocViewer slug={active} />
      </section>
    </div>
  )
}
