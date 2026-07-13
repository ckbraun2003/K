import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { Icon } from '../ui/Icon'
import DocViewer from '../components/DocViewer'

export default function DocsPage({ slug }: { slug?: string }) {
  const { data: artifacts = [] } = useQuery<Omit<Artifact, 'md' | 'html'>[]>({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })
  const active = slug ?? 'project-bible'

  return (
    <div className="flex h-full">
      <aside className="w-64 flex-shrink-0 overflow-y-auto border-r border-border">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Artifacts</h2>
        </div>
        {artifacts.map(a => (
          <button
            key={a.slug}
            onClick={() => navigate('docs', a.slug)}
            className={cn(
              'block w-full border-b border-border px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface',
              active === a.slug && 'border-l-2 border-l-accent bg-surface'
            )}
          >
            <span className="block truncate text-sm text-text">{a.title}</span>
            <span className="mono inline-flex items-center gap-1 text-[10px] text-muted">
              {new Date(a.updatedAt).toLocaleDateString()}
              {a.tags.includes('bible') && (
                <span className="inline-flex items-center gap-0.5">
                  · <Icon name="docs" size={14} /> bible
                </span>
              )}
              {(a.tags.includes('ui') || a.tags.includes('demo')) && (
                <span className="inline-flex items-center gap-0.5">
                  · <Icon name="monitor" size={14} /> ui
                </span>
              )}
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
