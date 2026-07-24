/**
 * <Background/> (usability-access P2.6 wallpaper UI) — route-agnostic
 * full-bleed backdrop mounted once at Shell z-0, rendering the operator's
 * saved wallpaper (GET /api/settings/background): a flat solid (with an
 * optional operator-chosen solidColor override) or an uploaded image.
 * Replaces the old animated galaxy canvas + living Ambient blobs system —
 * there is no canvas, no `requestAnimationFrame` loop, and nothing left here
 * for the `prefers-reduced-motion` CSS block to freeze. The gradient kind
 * (ui-adjustments Round 4 drops it from the UI) is no longer rendered
 * distinctly — a persisted `kind: 'gradient'` value falls through to the
 * solid branch.
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
 * Also applies the operator's colour overrides:
 *  - font colour (ui-adjustments Round 2, GET /api/settings/font-color):
 *    writes `--text` on the document root when a hex is set, or removes the
 *    inline override (falling back to the theme default) when `color` is
 *    null.
 *  - primary/secondary accent colour (ui-adjustments Round 4, GET
 *    /api/settings/{primary,secondary}-color): writes `--primary`/
 *    `--secondary` the same way. Setting `--primary` also derives and writes
 *    `--on-accent` (readable text/icon colour ON TOP of the primary swatch)
 *    via WCAG relative luminance — a dark primary gets a light on-accent and
 *    vice versa — since a single fixed on-accent token would go illegible
 *    against an arbitrary operator-chosen hue.
 * All three are folded in here rather than separate components since this is
 * the one place already mounted once at Shell z-0.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useBackgroundImageUrl } from '../lib/useBackgroundImageUrl'
import { ON_ACCENT_DARK, ON_ACCENT_LIGHT } from '../lib/tokens'

/** WCAG contrast-derived readable colour to paint ON TOP of a `--primary`
 *  swatch of `hex` (icons/glyphs/text). Computes the actual WCAG contrast
 *  ratio of `hex` against BOTH candidate inks and picks the higher-contrast
 *  winner — a fixed luminance threshold (e.g. `L > 0.4`) picks the
 *  lower-contrast ink across the mid-luminance band (a mid-tone teal can
 *  score under 3:1 against the threshold's pick when the OTHER ink actually
 *  clears 5:1 — see the crossover cases in background-appliers.test.tsx),
 *  and this approach stays correct even if the ink hexes themselves change.
 *  The two candidate inks are named constants in lib/tokens.ts (the raw-hex
 *  ui-token-gate exemption), not literals here. */
function onAccentFor(hex: string): string {
  const lum = (h: string) => {
    const n = parseInt(h.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
      const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const L = lum(hex)
  const contrast = (Li: number) => (Math.max(L, Li) + 0.05) / (Math.min(L, Li) + 0.05)
  return contrast(lum(ON_ACCENT_DARK)) >= contrast(lum(ON_ACCENT_LIGHT)) ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
}

export default function Background() {
  const { data } = useQuery({
    queryKey: ['background'],
    queryFn: () => api.settings.background.get(),
  })
  const { data: fontColorData } = useQuery({
    queryKey: ['fontColor'],
    queryFn: () => api.settings.fontColor.get(),
  })
  const { data: primaryColorData } = useQuery({
    queryKey: ['primaryColor'],
    queryFn: () => api.settings.primaryColor.get(),
  })
  const { data: secondaryColorData } = useQuery({
    queryKey: ['secondaryColor'],
    queryFn: () => api.settings.secondaryColor.get(),
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

  useEffect(() => {
    const primary = primaryColorData?.settings.color
    if (primary) {
      document.documentElement.style.setProperty('--primary', primary)
      document.documentElement.style.setProperty('--on-accent', onAccentFor(primary))
    } else {
      document.documentElement.style.removeProperty('--primary')
      document.documentElement.style.removeProperty('--on-accent')
    }
  }, [primaryColorData?.settings.color])

  useEffect(() => {
    const secondary = secondaryColorData?.settings.color
    if (secondary) {
      document.documentElement.style.setProperty('--secondary', secondary)
    } else {
      document.documentElement.style.removeProperty('--secondary')
    }
  }, [secondaryColorData?.settings.color])

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

  // solid — the loading/no-image-yet fallback, and a persisted gradient kind
  // (dropped from the UI) all fall through here.
  return (
    <div
      data-testid="app-background"
      data-variant="solid"
      aria-hidden
      className="ambient"
      style={{ background: settings?.solidColor ?? 'var(--bg-deep)' }}
    />
  )
}
