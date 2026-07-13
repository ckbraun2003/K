import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api, type BibleSectionView } from '../../lib/api'
import { cn } from '../../lib/cn'
import DocViewer from '../../components/DocViewer'
import Toast from '../../components/Toast'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, IconButton } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { EmptyState } from '../../ui/EmptyState'

/**
 * Project Artifacts tab (formerly "Bible"). Presents THIS project's artifacts as a
 * gallery — the project's OWN compiled bible (`project-<id>-bible`) plus anything else
 * namespaced to it (`project-<id>-*`) — each rendered through the shared DocViewer
 * (md/html toggle, sandboxed iframe), and keeps a bible recompile action scoped to this
 * project.
 *
 * Editing is source-of-truth aware:
 *   - a BIBLE is edited by SECTION — Save writes the section body back to its canonical
 *     `artifacts/bible/sections/<slug>.md` source (frontmatter preserved) and recompiles,
 *     so the edit survives the next recompile and a project bible never leaks into K's
 *     ARTIFACTS_DIR (F-029 / F-030). The whole-combined-md path is intentionally not used.
 *   - a regular artifact keeps the whole-markdown editor, passing its title/tags through
 *     so a save never clobbers the rail row to the bare slug (F-035).
 */
export default function ArtifactsTab({ projectId }: { projectId?: string }) {
  const qc = useQueryClient()

  const { data: artifacts = [], isLoading } = useQuery<Omit<Artifact, 'md' | 'html'>[]>({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })

  // The bible slug for THIS surface: a registered project shows its OWN
  // `project-<id>-bible` (compiled from its artifacts/bible/ sources), never the
  // harness's `project-bible`. With no projectId (harness context) it falls back to
  // the harness bible.
  const bibleSlug = projectId ? `project-${projectId}-bible` : 'project-bible'

  // F-038: a PROJECT surface lists ONLY that project's own artifacts (`project-<id>-*`,
  // which includes its bible + ui-demo). The harness's GLOBAL `ui-demo` / `project-bible`
  // are cross-scope and excluded here — they stay on the harness Docs surface. The
  // harness context (no projectId) still shows its own bible + the ui-demo reference.
  const mine = useMemo(() => {
    const isMine = (slug: string) =>
      projectId
        ? slug.startsWith(`project-${projectId}-`)
        : slug === 'project-bible' || slug === 'ui-demo'
    return artifacts.filter(a => isMine(a.slug))
  }, [artifacts, projectId])

  const [selected, setSelected] = useState<string | null>(null)
  // Default selection: prefer this surface's bible, else the first available artifact.
  const activeSlug =
    selected && mine.some(a => a.slug === selected)
      ? selected
      : mine.find(a => a.slug === bibleSlug)?.slug ?? mine[0]?.slug ?? null

  // ── Editor state ──────────────────────────────────────────────────────────
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  // Success confirmation (F-035): the message doubles as the open flag.
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  // Whole-markdown editor (regular artifacts) + section editor (bible) working state.
  const [editMd, setEditMd] = useState<string | null>(null)
  const [sectionSlug, setSectionSlug] = useState<string | null>(null)
  const [sectionBody, setSectionBody] = useState<string | null>(null)

  const editingArtifact = mine.find(a => a.slug === editingSlug)
  const editingIsBible =
    !!editingSlug && (editingSlug === bibleSlug || (editingArtifact?.tags.includes('bible') ?? false))

  const openEditor = (slug: string) => {
    setEditingSlug(slug)
    setEditError(null)
    setEditMd(null)
    setSectionSlug(null)
    setSectionBody(null)
  }
  const closeEditor = () => {
    setEditingSlug(null)
    setEditError(null)
    setEditMd(null)
    setSectionSlug(null)
    setSectionBody(null)
  }

  // ── Whole-markdown editor (regular, non-bible artifacts) ──
  const loadArtifact = useQuery<Artifact>({
    queryKey: ['artifacts', editingSlug],
    queryFn: () => api.artifacts.get(editingSlug!),
    enabled: !!editingSlug && !editingIsBible,
    staleTime: 0,
  })
  const displayMd = editMd ?? loadArtifact.data?.md ?? ''

  const saveMd = useMutation({
    // Pass the loaded title/tags/phase/status THROUGH so the save doesn't reset the
    // rail row to the bare slug / drop its badge (F-035).
    mutationFn: (md: string) =>
      api.artifacts.save(editingSlug!, {
        md,
        title: loadArtifact.data?.title,
        tags: loadArtifact.data?.tags,
        phase: loadArtifact.data?.phase,
        status: loadArtifact.data?.status,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artifacts'] })
      qc.invalidateQueries({ queryKey: ['artifact', editingSlug] })
      setSavedMsg('Saved')
      closeEditor()
    },
    onError: (e: Error) => setEditError(e.message),
  })

  // ── Section editor (bible artifacts) ──
  const sectionsQuery = useQuery<{ sections: BibleSectionView[] }>({
    queryKey: ['artifacts', editingSlug, 'sections'],
    queryFn: () => api.artifacts.sections(editingSlug!),
    enabled: !!editingSlug && editingIsBible,
    staleTime: 0,
  })
  const sections = sectionsQuery.data?.sections ?? []
  const activeSection =
    (sectionSlug && sections.find(s => s.slug === sectionSlug)) || sections[0] || null
  // Body shown: the local edit if touched, else the selected section's stored body.
  const sectionDisplay = sectionBody ?? activeSection?.body ?? ''

  const saveSection = useMutation({
    mutationFn: ({ section, body }: { section: string; body: string }) =>
      api.artifacts.saveSection(editingSlug!, section, body),
    onSuccess: () => {
      // The server rewrote the section source + recompiled → the row (title/tags) and
      // composed html regenerate from the edit. Refresh the list + the viewer.
      qc.invalidateQueries({ queryKey: ['artifacts'] })
      qc.invalidateQueries({ queryKey: ['artifact', editingSlug] })
      qc.invalidateQueries({ queryKey: ['artifacts', editingSlug, 'sections'] })
      setSavedMsg('Saved · bible recompiled')
      closeEditor()
    },
    onError: (e: Error) => setEditError(e.message),
  })

  // Recompile scoped to THIS surface: a registered project recompiles its own bible
  // (project route → `project-<id>-bible`); the harness context recompiles the global one.
  const compile = useMutation({
    mutationFn: () => (projectId ? api.projects.compileBible(projectId) : api.artifacts.compileBible()),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['artifacts', bibleSlug] })
      qc.invalidateQueries({ queryKey: ['artifact', bibleSlug] })
      qc.invalidateQueries({ queryKey: ['artifacts'] })
      // F-034: the recompile regenerated a git-TRACKED deliverable — surface WHICH
      // file it wrote so a resulting dirty working tree isn't a surprise.
      setSavedMsg(`Bible recompiled · updated tracked file ${result.htmlPath}`)
    },
  })

  function artifactBadge(tags: string[]): IconName {
    if (tags.includes('bible')) return 'docs'
    if (tags.includes('ui') || tags.includes('demo')) return 'monitor'
    return 'file'
  }

  const savePending = saveMd.isPending || saveSection.isPending
  const editorLoading = editingIsBible ? sectionsQuery.isLoading : loadArtifact.isLoading

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Button
          variant="primary"
          size="sm"
          icon="bolt"
          onClick={() => compile.mutate()}
          disabled={compile.isPending}
          loading={compile.isPending}
        >
          {compile.isPending ? 'Compiling…' : 'Recompile bible'}
        </Button>

        {mine.length > 0 && (
          <Select
            onChange={e => { if (e.target.value) openEditor(e.target.value); e.target.value = '' }}
            defaultValue=""
            aria-label="Edit an artifact"
            data-testid="artifact-edit-select"
            className="mono w-auto cursor-pointer text-xs"
          >
            <option value="" disabled>Edit…</option>
            {mine.map(a => (
              <option key={a.slug} value={a.slug}>{a.title ?? a.slug}</option>
            ))}
          </Select>
        )}

        {compile.error && (
          <span className="flex items-center gap-1 text-[11px] text-red">
            <Icon name="warning" size={14} />
            {String(compile.error)}
          </span>
        )}
      </div>

      {/* ── Gallery rail + viewer ────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 flex-shrink-0 overflow-y-auto border-r border-border bg-surface">
          {isLoading && <p className="px-4 py-3 text-xs text-muted">Loading…</p>}
          {!isLoading && mine.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted">No artifacts yet.</p>
          )}
          {mine.map(a => {
            const isActive = a.slug === activeSlug
            return (
              <button
                key={a.slug}
                onClick={() => setSelected(a.slug)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'block w-full border-b border-border px-4 py-2.5 text-left transition-colors duration-150',
                  isActive
                    ? 'border-l-2 border-l-accent bg-accent/10'
                    : 'hover:bg-raised',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm text-text">
                  <Icon name={artifactBadge(a.tags)} size={14} className="flex-shrink-0 text-muted" />
                  <span className="truncate">{a.title ?? a.slug}</span>
                </span>
                <span className="mono text-[10px] text-muted">
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
            <EmptyState
              icon="docs"
              headline="No compiled artifacts for this project yet."
              action={
                <Button variant="primary" size="sm" icon="bolt" onClick={() => compile.mutate()} disabled={compile.isPending} loading={compile.isPending}>
                  {compile.isPending ? 'Compiling…' : 'Compile bible'}
                </Button>
              }
            />
          )}
        </section>
      </div>

      {/* ── Editor (modal overlay) ──────────────────────────────────────── */}
      {editingSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="flex w-full max-w-3xl flex-col rounded-panel border border-border bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="mono text-xs text-muted">
                {editingIsBible ? 'Editing bible section' : 'Editing'}:{' '}
                <span className="text-text">
                  {editingIsBible ? (activeSection?.slug ?? editingSlug) : editingSlug}
                </span>
              </span>
              <IconButton name="close" variant="ghost" label="Close editor" onClick={closeEditor} />
            </div>

            {editingIsBible && (
              <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                <label className="mono text-[11px] text-muted">Section</label>
                <Select
                  value={activeSection?.slug ?? ''}
                  onChange={e => { setSectionSlug(e.target.value); setSectionBody(null); setEditError(null) }}
                  aria-label="Choose a bible section to edit"
                  data-testid="bible-section-select"
                  className="mono w-auto cursor-pointer text-xs"
                >
                  {sections.map(s => (
                    <option key={s.slug} value={s.slug}>{s.icon} {s.title}</option>
                  ))}
                </Select>
              </div>
            )}

            {editorLoading ? (
              <p className="p-6 text-center text-sm text-muted">Loading…</p>
            ) : editingIsBible && sections.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">
                This bible has no editable sections yet — compile it first.
              </p>
            ) : (
              <>
                <textarea
                  value={editingIsBible ? sectionDisplay : displayMd}
                  onChange={e => (editingIsBible ? setSectionBody(e.target.value) : setEditMd(e.target.value))}
                  spellCheck={false}
                  data-testid="artifact-editor-textarea"
                  className="mono min-h-[400px] w-full resize-y bg-raised px-4 py-3 text-xs text-text focus:outline-none"
                />
                {editError && (
                  <p className="flex items-center gap-1 px-4 py-1 text-[11px] text-red" data-testid="artifact-editor-error">
                    <Icon name="warning" size={14} />
                    {editError}
                  </p>
                )}
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                  <Button variant="ghost" size="sm" onClick={closeEditor}>Cancel</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={savePending}
                    onClick={() =>
                      editingIsBible
                        ? activeSection && saveSection.mutate({ section: activeSection.slug, body: sectionDisplay })
                        : saveMd.mutate(displayMd)
                    }
                    disabled={savePending || (editingIsBible && !activeSection)}
                    data-testid="artifact-save-btn"
                  >
                    {savePending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Toast
        open={!!savedMsg}
        message={savedMsg ?? ''}
        testid="artifact-saved-toast"
        onDismiss={() => setSavedMsg(null)}
      />
    </div>
  )
}
