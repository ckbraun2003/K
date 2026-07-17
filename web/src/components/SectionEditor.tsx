import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { BibleSectionView } from '../lib/api'
import { api } from '../lib/api'
import { Select, Textarea } from '../ui/Field'

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
    <div data-testid="section-editor" className="flex flex-col gap-2 border-t border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-text">Edit sections</span>
        <Select
          data-testid="section-editor-select"
          className="px-2 py-1 text-xs"
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
        </Select>
        {savedAt && <span className="text-[10px] text-green">saved · recompiled {new Date(savedAt).toLocaleTimeString()}</span>}
      </div>
      {active && (
        <>
          <Textarea
            data-testid="section-editor-body"
            className="min-h-40 w-full p-2 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="section-editor-save"
              disabled={save.isPending || draft === active.body}
              onClick={() => save.mutate()}
              className="rounded bg-accent px-3 py-1 text-xs text-on-accent disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save section'}
            </button>
            {save.isError && <span className="text-[10px] text-red">save failed</span>}
          </div>
        </>
      )}
    </div>
  )
}
