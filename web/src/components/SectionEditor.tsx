import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { BibleSectionView } from '../lib/api'
import { api } from '../lib/api'

/**
 * P4 E-30 — edit-in-place for bible docs. Uses the EXISTING section-write API
 * (PUT /api/artifacts/:slug/sections/:sectionSlug). Renders nothing for non-bible artifacts
 * (the sections endpoint returns no editable sections). Compose-is-confirm: Save writes the
 * one section body back to its canonical source + recompiles; the viewer refetches.
 */
export default function SectionEditor({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['artifact-sections', slug],
    queryFn: () => api.artifacts.sections(slug),
    retry: false,
  })
  const sections: BibleSectionView[] = data?.sections ?? []
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const active = sections.find((s) => s.slug === activeSlug) ?? null

  const save = useMutation({
    mutationFn: () => api.artifacts.saveSection(slug, activeSlug!, draft),
    onSuccess: (res) => {
      setSavedAt(res.compiledAt)
      qc.invalidateQueries({ queryKey: ['artifact', slug] })
      qc.invalidateQueries({ queryKey: ['artifact-sections', slug] })
    },
  })

  if (sections.length === 0) return null // non-bible artifact — no editable sections

  return (
    <div data-testid="section-editor" className="flex flex-col gap-2 border-t border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text)]">Edit sections</span>
        <select
          data-testid="section-editor-select"
          className="rounded border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)]"
          value={activeSlug ?? ''}
          onChange={(e) => {
            const next = sections.find((s) => s.slug === e.target.value) ?? null
            setActiveSlug(next?.slug ?? null)
            setDraft(next?.body ?? '')
            setSavedAt(null)
          }}
        >
          <option value="">Choose a section…</option>
          {sections.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
        </select>
        {savedAt && <span className="text-[10px] text-[var(--green)]">saved · recompiled {new Date(savedAt).toLocaleTimeString()}</span>}
      </div>
      {active && (
        <>
          <textarea
            data-testid="section-editor-body"
            className="min-h-40 w-full rounded border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-xs text-[var(--text)]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="section-editor-save"
              disabled={save.isPending || draft === active.body}
              onClick={() => save.mutate()}
              className="rounded bg-[var(--accent)] px-3 py-1 text-xs text-[var(--on-accent)] disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save section'}
            </button>
            {save.isError && <span className="text-[10px] text-[var(--red)]">save failed</span>}
          </div>
        </>
      )}
    </div>
  )
}
