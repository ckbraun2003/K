/**
 * <Background/> (usability-access P2.6 wallpaper UI) — route-agnostic
 * full-bleed backdrop mounted once at Shell z-0, rendering the operator's
 * saved wallpaper (GET /api/settings/background): a flat solid, one of four
 * static CSS gradient presets, or an uploaded image. Replaces the old
 * animated galaxy canvas + living Ambient blobs system — there is no canvas,
 * no `requestAnimationFrame` loop, and nothing left here for the
 * `prefers-reduced-motion` CSS block to freeze.
 *
 * `kind: 'image'` needs an AUTHENTICATED fetch: every /api/* route is
 * Bearer-gated, so a raw CSS `url()`/`<img src>` can't attach the header and
 * would 401. useBackgroundImageUrl() fetches the bytes the same way req()
 * authenticates and exposes a revocable object URL, keyed on `imageVersion`
 * so a re-upload swaps it immediately.
 *
 * The backdrop is purely decorative → `aria-hidden` on the root, matching
 * the retired Ambient's own contract, so screen readers skip it. While the
 * query is loading (`settings` undefined), the root degrades to `solid` —
 * same visual either way — so nothing flashes in/out once the real
 * preference resolves.
 *
 * Also applies the operator's font-colour override (ui-adjustments Round 2,
 * GET /api/settings/font-color): writes `--text` on the document root when a
 * hex is set, or removes the inline override (falling back to the theme
 * default) when `color` is null. Folded in here rather than a separate
 * component since this is the one place already mounted once at Shell z-0.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useBackgroundImageUrl } from '../lib/useBackgroundImageUrl'

export default function Background() {
  const { data } = useQuery({
    queryKey: ['background'],
    queryFn: () => api.settings.background.get(),
  })
  const { data: fontColorData } = useQuery({
    queryKey: ['fontColor'],
    queryFn: () => api.settings.fontColor.get(),
  })
  const settings = data?.settings
  const kind = settings?.kind ?? 'solid'
  const imageUrl = useBackgroundImageUrl(kind, settings?.imageVersion ?? null)

  useEffect(() => {
    const color = fontColorData?.settings.color
    if (color) {
      document.documentElement.style.setProperty('--text', color)
    } else {
      document.documentElement.style.removeProperty('--text')
    }
  }, [fontColorData?.settings.color])

  if (kind === 'image' && imageUrl) {
    return (
      <div
        data-testid="app-background"
        data-variant="image"
        aria-hidden
        className="ambient"
        style={{ backgroundImage: `url(${imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
    )
  }

  if (kind === 'gradient') {
    const preset = settings?.preset ?? 'aurora'
    return (
      <div
        data-testid="app-background"
        data-variant="gradient"
        aria-hidden
        className={`ambient bg-gradient-${preset}`}
      />
    )
  }

  // solid — and the loading/no-image-yet fallback.
  return (
    <div
      data-testid="app-background"
      data-variant="solid"
      aria-hidden
      className="ambient"
      style={{ background: 'var(--bg-deep)' }}
    />
  )
}
