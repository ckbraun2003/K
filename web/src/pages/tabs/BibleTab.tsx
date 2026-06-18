import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'

// ─── Component ───────────────────────────────────────────────────────────────

export default function BibleTab({ projectId: _projectId }: { projectId?: string }) {
  const qc = useQueryClient()

  // Fetch all artifacts (metadata only) so we can list bible sections
  const { data: artifacts = [], isLoading: artifactsLoading } = useQuery<
    Omit<Artifact, 'md' | 'html'>[]
  >({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })

  // Fetch the compiled bible HTML
  const { data: bibleArtifact, isLoading: bibleLoading } = useQuery<Artifact>({
    queryKey: ['artifacts', 'project-bible'],
    queryFn: () => api.artifacts.get('project-bible'),
    retry: false,
  })

  // Edit state — null means "not yet touched by user"; '' means user cleared the textarea
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editMd, setEditMd] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  // Load a section for editing — staleTime:0 ensures fresh content on each open
  const loadSection = useQuery<Artifact>({
    queryKey: ['artifacts', editingSlug],
    queryFn: () => api.artifacts.get(editingSlug!),
    enabled: !!editingSlug,
    staleTime: 0,
  })

  // When a section opens, reset edit state (null = not yet touched)
  const openSection = (slug: string) => {
    setEditingSlug(slug)
    setEditError(null)
    setEditMd(null)
  }

  // Sync md into textarea — null-coalescing so clearing the textarea (empty string) is honoured
  const sectionMd = loadSection.data?.md ?? ''
  const displayMd = editMd ?? sectionMd

  const save = useMutation({
    mutationFn: (md: string) =>
      api.artifacts.save(editingSlug!, { md }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artifacts'] })
      setEditingSlug(null)
      setEditMd(null)
      setEditError(null)
    },
    onError: (e: Error) => {
      setEditError(e.message)
    },
  })

  const compile = useMutation({
    mutationFn: api.artifacts.compileBible,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artifacts', 'project-bible'] })
      qc.invalidateQueries({ queryKey: ['artifacts'] })
    },
  })

  const bibleHtml = bibleArtifact?.html ?? ''

  // Filter artifacts to surface likely bible sections (exclude the compiled one)
  const sections = artifacts.filter(a => a.slug !== 'project-bible')

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-5 py-3">
        <button
          onClick={() => compile.mutate()}
          disabled={compile.isPending}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {compile.isPending ? 'Compiling…' : '⚡ Recompile'}
        </button>

        {sections.length > 0 && (
          <div className="relative">
            <select
              onChange={e => {
                if (e.target.value) openSection(e.target.value)
                e.target.value = ''
              }}
              defaultValue=""
              className={cn(
                'mono rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1.5 text-xs text-[var(--text)]',
                'cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
              )}
            >
              <option value="" disabled>
                Edit section…
              </option>
              {sections.map(a => (
                <option key={a.slug} value={a.slug}>
                  {a.title ?? a.slug}
                </option>
              ))}
            </select>
          </div>
        )}

        {!artifactsLoading && sections.length === 0 && (
          <span className="text-xs text-[var(--muted)]">No sections found</span>
        )}

        {compile.error && (
          <span className="text-[11px] text-[var(--red)]">
            ⚠ {String(compile.error)}
          </span>
        )}
      </div>

      {/* ── Section editor (modal overlay) ───────────────────────────────── */}
      {editingSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-3xl flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <span className="mono text-xs text-[var(--muted)]">
                Editing: <span className="text-[var(--text)]">{editingSlug}</span>
              </span>
              <button
                onClick={() => {
                  setEditingSlug(null)
                  setEditMd(null)
                  setEditError(null)
                }}
                className="text-[var(--muted)] hover:text-[var(--text)]"
                aria-label="Close editor"
              >
                ✕
              </button>
            </div>

            {loadSection.isLoading ? (
              <p className="p-6 text-center text-sm text-[var(--muted)]">Loading…</p>
            ) : (
              <>
                <textarea
                  value={displayMd}
                  onChange={e => setEditMd(e.target.value)}
                  spellCheck={false}
                  className={cn(
                    'mono min-h-[400px] w-full resize-y bg-[var(--raised)] px-4 py-3 text-xs text-[var(--text)]',
                    'focus:outline-none',
                  )}
                />
                {editError && (
                  <p className="px-4 py-1 text-[11px] text-[var(--red)]">⚠ {editError}</p>
                )}
                <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
                  <button
                    onClick={() => {
                      setEditingSlug(null)
                      setEditMd(null)
                      setEditError(null)
                    }}
                    className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs text-[var(--text)] hover:border-[var(--accent)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => save.mutate(displayMd)}
                    disabled={save.isPending}
                    className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {save.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Bible iframe ─────────────────────────────────────────────────── */}
      <div className="relative flex-1">
        {bibleLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            Loading bible…
          </div>
        ) : !bibleHtml ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--muted)]">
            <p>No compiled bible found.</p>
            <button
              onClick={() => compile.mutate()}
              disabled={compile.isPending}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {compile.isPending ? 'Compiling…' : '⚡ Compile Bible'}
            </button>
          </div>
        ) : (
          <iframe
            srcDoc={bibleHtml}
            sandbox="allow-same-origin"
            className="w-full h-full min-h-[600px] border-0"
            title="Project Bible"
          />
        )}
      </div>
    </div>
  )
}
