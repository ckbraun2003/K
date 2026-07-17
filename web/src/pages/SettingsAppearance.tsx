/**
 * Settings → Appearance (usability-access B.5) — the operator's saved
 * background preference. Mirrors ClaudeModelSection (SettingsModels.tsx):
 * GlassPanel + SectionHeader + useQuery/useMutation over
 * api.settings.background, invalidating `['background']` on save so
 * <Background/> (mounted at Shell z-0) picks up the change immediately.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { BackgroundVariant } from '@k/shared'
import { api } from '../lib/api'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { Select } from '../ui/Field'
import { SkeletonRow } from '../ui/Skeleton'

const VARIANT_LABELS: Record<BackgroundVariant, string> = {
  galaxy: 'Galaxy',
  aurora: 'Aurora',
  blobs: 'Blobs',
  solid: 'Solid',
}

export function BackgroundSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['background'],
    queryFn: () => api.settings.background.get(),
  })
  const save = useMutation({
    mutationFn: (variant: BackgroundVariant) => api.settings.background.set(variant),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['background'] })
    },
  })

  return (
    <GlassPanel data-testid="appearance-section" className="p-4">
      <SectionHeader label="Appearance" as="h2" />
      <p className="mt-1 text-caption text-muted">
        The ambient backdrop behind every page.
      </p>
      {isLoading ? (
        <SkeletonRow />
      ) : error || !data ? (
        <p className="mt-2 text-caption text-red">Failed to load the background preference.</p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <Select
            aria-label="Background"
            data-testid="background-select"
            value={data.variant}
            disabled={save.isPending}
            onChange={e => save.mutate(e.target.value as BackgroundVariant)}
            className="text-label"
          >
            {data.options.map(v => (
              <option key={v} value={v}>{VARIANT_LABELS[v]}</option>
            ))}
          </Select>
          {save.isPending && <span className="text-caption text-muted">saving…</span>}
        </div>
      )}
      {save.error && (
        <p className="mt-2 text-caption text-red">
          {save.error instanceof Error ? save.error.message : 'Save failed.'}
        </p>
      )}
    </GlassPanel>
  )
}
