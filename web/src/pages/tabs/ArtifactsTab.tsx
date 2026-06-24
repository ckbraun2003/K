import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import DocViewer from '../../components/DocViewer'

/**
 * Project Artifacts tab (formerly "Bible"). Presents this project's artifacts as a
 * gallery — the compiled bible, the project's UI demo, and the harness ui-demo — each
 * rendered through the shared DocViewer (md/html toggle, sandboxed iframe). Keeps the
 * per-artifact markdown editor and the bible recompile action.
 */
export default function ArtifactsTab({ projectId }: { projectId?: string }) {
  const qc = useQueryClient()

  const { data: artifacts = [], isLoading } = useQuery<Omit<Artifact, 'md' | 'html'>[]>({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })

  // This project's artifacts: anything namespaced to it (project-<id>-*), plus the
  // shared harness artifacts (the compiled bible + the ui-demo) which document the
  // platform every project runs on. Honest about scope without a backend change.
  const mine = useMemo(() => {
    const isMine = (slug: string) =>
      slug === 'project-bible' ||
      slug === 'ui-demo' ||
      (projectId ? slug.startsWith(`project-${projectId}-`) : false)
    return artifacts.filter(a => isMine(a.slug))
  }, [artifacts, projectId])

  const [selected, setSelected] = useState<string | null>(null)
  // Default selection: prefer the bible, else the first available artifact.
  const activeSlug =
    selected && mine.some(a => a.slug === selected)
      ? selected
      : mine.find(a => a.slug === 'project-bible')?.slug ?? mine[0]?.slug ?? null

  // ── Per-artifact markdown editor (null = untouched; '' = user cleared it) ──
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editMd, setEditMd] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const loadSection = useQuery<Artifact>({
    queryKey: ['artifacts', editingSlug],
    queryFn: () => api.artifacts.get(editingSlug!),
    enabled: !!editingSlug,
    staleTime: 0,
  })
  const displayMd = editMd ?? loadSection.data?.md ?? ''
  const closeEditor = () => { setEditingSlug(null); setEditMd(null); setEditError(null) }

  const save = useMutation({
    mutationFn: (md: string) => api.artifacts.save(editingSlug!, { md }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artifacts'] }); closeEditor() },
    onError: (e: Error) => setEditError(e.message),
  })

  const compile = useMutation({
    mutationFn: api.artifacts.compileBible,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artifacts', 'project-bible'] })
      qc.invalidateQueries({ queryKey: ['artifact', 'project-bible'] })
      qc.invalidateQueries({ queryKey: ['artifacts'] })
    },
  })

  function artifactBadge(tags: string[]): string {
    if (tags.includes('bible')) return '📖'
    if (tags.includes('ui') || tags.includes('demo')) return '🖥'
    return '📄'
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-5 py-3">
        <button
          onClick={() => compile.mutate()}
          disabled={compile.isPending}
          className="rounded-control bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          {compile.isPending ? 'Compiling…' : '⚡ Recompile bible'}
        </button>

        {mine.length > 0 && (
          <select
            onChange={e => { if (e.target.value) { setEditingSlug(e.target.value); setEditMd(null); setEditError(null) } e.target.value = '' }}
            defaultValue=""
            aria-label="Edit an artifact's markdown"
            className="mono cursor-pointer rounded-control border border-[var(--border)] bg-[var(--raised)] px-2.5 py-2 text-xs text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-hover)]"
          >
            <option value="" disabled>Edit markdown…</option>
            {mine.map(a => (
              <option key={a.slug} value={a.slug}>{a.title ?? a.slug}</option>
            ))}
          </select>
        )}

        {compile.error && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(compile.error)}</span>
        )}
      </div>

      {/* ── Gallery rail + viewer ────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 flex-shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)]">
          {isLoading && <p className="px-4 py-3 text-xs text-[var(--muted)]">Loading…</p>}
          {!isLoading && mine.length === 0 && (
            <p className="px-4 py-3 text-xs text-[var(--muted)]">No artifacts yet.</p>
          )}
          {mine.map(a => {
            const isActive = a.slug === activeSlug
            return (
              <button
                key={a.slug}
                onClick={() => setSelected(a.slug)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'block w-full border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors duration-150',
                  isActive
                    ? 'border-l-2 border-l-[var(--accent)] bg-[color:rgba(255,143,192,0.10)]'
                    : 'hover:bg-[var(--raised)]',
                )}
              >
                <span className="block truncate text-sm text-[var(--text)]">
                  <span className="mr-1.5">{artifactBadge(a.tags)}</span>{a.title ?? a.slug}
                </span>
                <span className="mono text-[10px] text-[var(--muted)]">
                  {new Date(a.updatedAt).toLocaleDateString()}
                </span>
              </button>
            )
          })}
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden">
          {activeSlug ? (
            <DocViewer slug={activeSlug} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--muted)]">
              <p>No compiled artifacts for this project yet.</p>
              <button
                onClick={() => compile.mutate()}
                disabled={compile.isPending}
                className="rounded-control bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                {compile.isPending ? 'Compiling…' : '⚡ Compile bible'}
              </button>
            </div>
          )}
        </section>
      </div>

      {/* ── Markdown editor (modal overlay) ─────────────────────────────── */}
      {editingSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="flex w-full max-w-3xl flex-col rounded-panel border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <span className="mono text-xs text-[var(--muted)]">
                Editing: <span className="text-[var(--text)]">{editingSlug}</span>
              </span>
              <button onClick={closeEditor} className="text-[var(--muted)] hover:text-[var(--text)]" aria-label="Close editor">✕</button>
            </div>
            {loadSection.isLoading ? (
              <p className="p-6 text-center text-sm text-[var(--muted)]">Loading…</p>
            ) : (
              <>
                <textarea
                  value={displayMd}
                  onChange={e => setEditMd(e.target.value)}
                  spellCheck={false}
                  className="mono min-h-[400px] w-full resize-y bg-[var(--raised)] px-4 py-3 text-xs text-[var(--text)] focus:outline-none"
                />
                {editError && <p className="px-4 py-1 text-[11px] text-[var(--red)]">⚠ {editError}</p>}
                <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
                  <button onClick={closeEditor} className="rounded-control border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs text-[var(--text)] hover:border-[var(--accent-hover)]">Cancel</button>
                  <button
                    onClick={() => save.mutate(displayMd)}
                    disabled={save.isPending}
                    className="rounded-control bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                  >
                    {save.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
