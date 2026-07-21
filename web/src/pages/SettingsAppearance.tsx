/**
 * Settings → Appearance (usability-access P2.6 wallpaper UI) — the operator's
 * saved wallpaper (GET/PUT /api/settings/background + PUT .../image). Mirrors
 * ClaudeModelSection (SettingsModels.tsx): GlassPanel + SectionHeader +
 * useQuery/useMutation, invalidating `['background']` on every change so
 * <Background/> (mounted at Shell z-0) picks up the change immediately.
 *
 * The `image` kind's option is disabled until an image has been uploaded at
 * least once (`imageVersion != null`) — the backend 400s a bare kind:'image'
 * switch when no wallpaper file exists on disk (routes/settings.ts), so a
 * disabled option is simpler and fully avoids that error path rather than
 * surfacing it. The upload control itself is always available regardless of
 * the currently selected kind — uploading switches the wallpaper to `image`
 * server-side.
 */
import { useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BackgroundKind, GradientPreset } from '@k/shared'
import { api } from '../lib/api'
import { useBackgroundImageUrl } from '../lib/useBackgroundImageUrl'
import { readToken } from '../lib/tokens'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { Select } from '../ui/Field'
import { Button } from '../ui/Button'
import { SkeletonRow } from '../ui/Skeleton'
import { cn } from '../lib/cn'

const KIND_LABELS: Record<BackgroundKind, string> = {
  solid: 'Solid',
  gradient: 'Gradient',
  image: 'Image',
}
const PRESET_LABELS: Record<GradientPreset, string> = {
  aurora: 'Aurora',
  dusk: 'Dusk',
  ocean: 'Ocean',
  ember: 'Ember',
}
const KIND_ORDER: BackgroundKind[] = ['solid', 'gradient', 'image']

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read that file.'))
    }
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

/** Decode an image data URL just far enough to read its natural pixel size —
 *  used only for the advisory too-small warning below, never to block upload. */
function probeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Could not read that image.'))
    img.src = dataUrl
  })
}

export function BackgroundSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['background'],
    queryFn: () => api.settings.background.get(),
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [sizeWarning, setSizeWarning] = useState<string | null>(null)

  const setMutation = useMutation({
    mutationFn: (patch: { kind: BackgroundKind; preset: GradientPreset | null }) =>
      api.settings.background.set(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['background'] })
    },
  })
  const uploadMutation = useMutation({
    mutationFn: (dataUrl: string) => api.settings.background.uploadImage(dataUrl),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['background'] })
    },
  })

  const settings = data?.settings
  const presets = data?.presets ?? []
  const hasImage = settings?.imageVersion != null
  // Pass the CURRENT kind (not a literal 'image'): the swatch only reads
  // previewUrl when kind==='image', so fetching the blob under solid/gradient
  // was a wasted authenticated round-trip on every Appearance mount (M2).
  const previewUrl = useBackgroundImageUrl(settings?.kind ?? 'solid', settings?.imageVersion ?? null)
  const saving = setMutation.isPending || uploadMutation.isPending

  function onKindChange(kind: BackgroundKind) {
    setMutation.mutate({
      kind,
      preset: kind === 'gradient' ? (settings?.preset ?? presets[0] ?? 'aurora') : null,
    })
  }

  function onPresetChange(preset: GradientPreset) {
    setMutation.mutate({ kind: 'gradient', preset })
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    setFileError(null)
    setSizeWarning(null)
    try {
      const dataUrl = await readFileAsDataUrl(file)
      uploadMutation.mutate(dataUrl) // never blocked by the dimension probe below
      try {
        const { width, height } = await probeImageDimensions(dataUrl)
        const dpr = window.devicePixelRatio || 1
        const screenW = Math.round(window.innerWidth * dpr)
        const screenH = Math.round(window.innerHeight * dpr)
        if (width < screenW || height < screenH) {
          setSizeWarning(
            `This image (${width}×${height}) is smaller than your screen (${screenW}×${screenH}) ` +
            'and may look soft when stretched to fill.',
          )
        }
      } catch {
        // Advisory only — a failed probe (e.g. an unsupported format) never blocks upload.
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not read that file.')
    }
  }

  const mutationError = setMutation.error ?? uploadMutation.error
  const errorMessage =
    fileError ?? (mutationError instanceof Error ? mutationError.message : mutationError ? 'Save failed.' : null)

  return (
    <GlassPanel data-testid="appearance-section" className="p-4">
      <SectionHeader label="Appearance" as="h2" />
      <p className="mt-1 text-caption text-muted">
        The wallpaper behind every page.
      </p>
      {isLoading ? (
        <SkeletonRow />
      ) : error || !settings ? (
        <p className="mt-2 text-caption text-red">Failed to load the wallpaper preference.</p>
      ) : (
        <div className="mt-2 flex items-start gap-4">
          <div
            data-testid="background-preview"
            className={cn(
              'h-16 w-28 shrink-0 rounded-control border border-border bg-cover bg-center',
              settings.kind === 'gradient' && `bg-gradient-${settings.preset ?? presets[0] ?? 'aurora'}`,
            )}
            style={
              settings.kind === 'solid'
                ? { background: 'var(--bg-deep)' }
                : settings.kind === 'image' && previewUrl
                  ? { backgroundImage: `url(${previewUrl})` }
                  : settings.kind === 'image'
                    ? { background: 'var(--bg-deep)' }
                    : undefined
            }
          />

          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-3">
              <Select
                aria-label="Wallpaper kind"
                data-testid="background-kind-select"
                value={settings.kind}
                disabled={saving}
                onChange={e => onKindChange(e.target.value as BackgroundKind)}
                className="text-label"
              >
                {KIND_ORDER.map(k => (
                  <option key={k} value={k} disabled={k === 'image' && !hasImage}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
              {settings.kind === 'gradient' && (
                <Select
                  aria-label="Gradient preset"
                  data-testid="background-preset-select"
                  value={settings.preset ?? presets[0] ?? 'aurora'}
                  disabled={saving}
                  onChange={e => onPresetChange(e.target.value as GradientPreset)}
                  className="text-label"
                >
                  {presets.map(p => (
                    <option key={p} value={p}>{PRESET_LABELS[p]}</option>
                  ))}
                </Select>
              )}
              {saving && <span className="text-caption text-muted">saving…</span>}
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="glass"
                size="sm"
                type="button"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
              >
                {hasImage ? 'Set background' : 'Upload image…'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-testid="background-image-input"
                className="sr-only"
                onChange={onFileChange}
              />
            </div>
            {sizeWarning && (
              <p data-testid="background-size-warning" className="text-caption text-amber">
                {sizeWarning}
              </p>
            )}

            <FontColorPicker />
          </div>
        </div>
      )}
      {errorMessage && (
        <p className="mt-2 text-caption text-red">{errorMessage}</p>
      )}
    </GlassPanel>
  )
}

/**
 * Font-colour override (ui-adjustments Round 2) — the operator's body-text
 * colour when the default pale graphite-blue clashes with a custom
 * wallpaper. Mirrors the BackgroundSection query/mutation pattern; rendered
 * beside the wallpaper controls above. GET/PUT /api/settings/font-color
 * (app_config-backed, `Background.tsx` applies the value to `--text` at
 * runtime — see its docblock).
 */
function FontColorPicker() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['fontColor'],
    queryFn: () => api.settings.fontColor.get(),
  })
  const color = data?.settings.color ?? null
  // The native color input always needs a valid hex to show as its swatch —
  // when there's no override yet, fall back to the current --text token's
  // resolved value (never a hardcoded hex; see readToken/TOKEN_FALLBACKS).
  const swatchValue = color ?? readToken('--text')

  const mutation = useMutation({
    mutationFn: (patch: { color: string | null }) => api.settings.fontColor.set(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fontColor'] })
    },
  })

  return (
    <div className="flex items-center gap-3">
      <label htmlFor="font-color-input" className="text-label text-muted">
        Text color
      </label>
      <input
        id="font-color-input"
        type="color"
        aria-label="Text color"
        data-testid="font-color-input"
        value={swatchValue}
        disabled={mutation.isPending}
        onChange={e => mutation.mutate({ color: e.target.value })}
        className="h-8 w-12 cursor-pointer rounded-control border border-border bg-transparent p-0.5"
      />
      <Button
        variant="glass"
        size="sm"
        type="button"
        disabled={mutation.isPending || color === null}
        onClick={() => mutation.mutate({ color: null })}
      >
        Reset to default
      </Button>
      {mutation.isPending && <span className="text-caption text-muted">saving…</span>}
    </div>
  )
}
