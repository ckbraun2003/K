/**
 * Settings → Appearance (usability-access P2.6 wallpaper UI, extended
 * ui-adjustments Round 4 with a solid-color override + primary/secondary
 * accent pickers) — the operator's saved wallpaper (GET/PUT
 * /api/settings/background + PUT .../image). Mirrors ClaudeModelSection
 * (SettingsModels.tsx): GlassPanel + SectionHeader + useQuery/useMutation,
 * invalidating `['background']` on every change so <Background/> (mounted at
 * Shell z-0) picks up the change immediately.
 *
 * Round 4 drops the gradient backdrop kind from the UI entirely — the picker
 * is now a Solid | Image segmented toggle (SegControl), never a <select>. A
 * persisted legacy `kind: 'gradient'` value is coerced to display as the
 * Solid segment (Background.tsx does the matching render-side fallthrough).
 *
 * The `image` segment is disabled until an image has been uploaded at least
 * once (`imageVersion != null`) — the backend 400s a bare kind:'image'
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
import { Button } from '../ui/Button'
import { SkeletonRow } from '../ui/Skeleton'
import SegControl from '../components/SegControl'

/** The two backdrop kinds the operator can pick between now that gradient is
 *  gone from the UI. A persisted 'gradient' kind coerces to 'solid' here. */
type BgSegment = 'solid' | 'image'

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
    mutationFn: (patch: { kind: BackgroundKind; preset: GradientPreset | null; solidColor: string | null }) =>
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
  const hasImage = settings?.imageVersion != null
  // A persisted legacy 'gradient' kind (dropped from the UI) coerces to the
  // Solid segment — Background.tsx does the matching render-side fallthrough.
  const activeSegment: BgSegment = settings?.kind === 'image' ? 'image' : 'solid'
  // Pass the CURRENT kind (not a literal 'image'): the swatch only reads
  // previewUrl when kind==='image', so fetching the blob under solid
  // was a wasted authenticated round-trip on every Appearance mount (M2).
  const previewUrl = useBackgroundImageUrl(settings?.kind ?? 'solid', settings?.imageVersion ?? null)
  const saving = setMutation.isPending || uploadMutation.isPending

  function onSegmentChange(kind: BgSegment) {
    // solidColor is NOT preserved server-side when omitted (routes/settings.ts)
    // — carry the current value forward explicitly so switching Solid <-> Image
    // never silently drops the operator's chosen solid color.
    setMutation.mutate({ kind, preset: null, solidColor: settings?.solidColor ?? null })
  }

  function onSolidColorChange(color: string) {
    setMutation.mutate({ kind: 'solid', preset: null, solidColor: color })
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
            className="h-16 w-28 shrink-0 rounded-control border border-border bg-cover bg-center"
            style={
              activeSegment === 'image' && previewUrl
                ? { backgroundImage: `url(${previewUrl})` }
                : { background: settings.solidColor ?? 'var(--bg-deep)' }
            }
          />

          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-3">
              <SegControl<BgSegment>
                ariaLabel="Wallpaper kind"
                value={activeSegment}
                onChange={onSegmentChange}
                options={[
                  { label: 'Solid', value: 'solid', disabled: saving },
                  { label: 'Image', value: 'image', disabled: saving || !hasImage },
                ]}
              />
              {saving && <span className="text-caption text-muted">saving…</span>}
            </div>

            {activeSegment === 'solid' && (
              <div className="flex items-center gap-3">
                <label htmlFor="background-solid-color-input" className="text-label text-muted">
                  Background color
                </label>
                <input
                  id="background-solid-color-input"
                  type="color"
                  aria-label="Background color"
                  data-testid="background-solid-color"
                  value={settings.solidColor ?? readToken('--bg-deep')}
                  disabled={saving}
                  onChange={e => onSolidColorChange(e.target.value)}
                  className="h-8 w-12 cursor-pointer rounded-control border border-border bg-transparent p-0.5"
                />
              </div>
            )}

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
            <PrimaryColorPicker />
            <SecondaryColorPicker />
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

/**
 * Primary accent-colour override (ui-adjustments Round 4) — the operator's
 * `--primary` accent, applied by Background.tsx which also derives a
 * readable `--on-accent` from it via WCAG luminance. Structurally identical
 * to FontColorPicker above; GET/PUT /api/settings/primary-color.
 */
function PrimaryColorPicker() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['primaryColor'],
    queryFn: () => api.settings.primaryColor.get(),
  })
  const color = data?.settings.color ?? null
  const swatchValue = color ?? readToken('--primary')

  const mutation = useMutation({
    mutationFn: (patch: { color: string | null }) => api.settings.primaryColor.set(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['primaryColor'] })
    },
  })

  return (
    <div className="flex items-center gap-3">
      <label htmlFor="primary-color-input" className="text-label text-muted">
        Primary accent color
      </label>
      <input
        id="primary-color-input"
        type="color"
        aria-label="Primary accent color"
        data-testid="primary-color-input"
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

/**
 * Secondary accent-colour override (ui-adjustments Round 4) — the
 * operator's `--secondary` accent, applied by Background.tsx. Structurally
 * identical to FontColorPicker above; GET/PUT /api/settings/secondary-color.
 */
function SecondaryColorPicker() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['secondaryColor'],
    queryFn: () => api.settings.secondaryColor.get(),
  })
  const color = data?.settings.color ?? null
  const swatchValue = color ?? readToken('--secondary')

  const mutation = useMutation({
    mutationFn: (patch: { color: string | null }) => api.settings.secondaryColor.set(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['secondaryColor'] })
    },
  })

  return (
    <div className="flex items-center gap-3">
      <label htmlFor="secondary-color-input" className="text-label text-muted">
        Secondary accent color
      </label>
      <input
        id="secondary-color-input"
        type="color"
        aria-label="Secondary accent color"
        data-testid="secondary-color-input"
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
