/**
 * Route-agnostic ambient backdrop (usability-access B.4) — mounted once at
 * Shell z-0, replacing the always-on `<Ambient/>` blobs. Reads the operator's
 * saved preference (GET /api/settings/background) and renders one of four
 * variants:
 *
 *  - `galaxy` (default) — a drifting canvas starfield (see lib/starfield.ts),
 *    a single static draw under `prefersReducedMotion()`, animated otherwise.
 *  - `aurora` — a CSS gradient wash, no JS animation loop.
 *  - `blobs`  — the pre-existing LG2 `<Ambient/>` (kept intact: LoginScreen
 *    renders it independently pre-auth, and ambient.test.tsx locks its exact
 *    4-blob/aria-hidden contract). Wrapped in a passthrough shell that carries
 *    NO `.ambient` class, so there is never a second `.ambient` layer double-
 *    painting the background (Ambient is `position:fixed` and escapes the
 *    wrapper visually) — yet all four variants expose ONE uniform contract:
 *    `data-testid="app-background"` + `data-variant`.
 *
 * The backdrop is purely decorative → `aria-hidden` on every variant's root
 * (matching Ambient's own root), so screen readers skip the canvas/blobs.
 *  - `solid`  — nothing beyond the shared `.ambient` wrapper, which already
 *    paints `--bg-deep` + a faint noise wash.
 *
 * While the query is loading, renders the bare wrapper (no variant content)
 * so there is no flash of the wrong backdrop before the preference resolves.
 */
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BackgroundVariant } from '@k/shared'
import { api } from '../lib/api'
import { prefersReducedMotion } from '../lib/motion'
import { makeStars, drawStarfield } from '../lib/starfield'
import Ambient from './Ambient'

const STAR_COUNT = 260

function GalaxyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduced = prefersReducedMotion()
    let stars = makeStars(STAR_COUNT, canvas.clientWidth || 1, canvas.clientHeight || 1)
    let raf = 0

    function resize() {
      const dpr = window.devicePixelRatio || 1
      const w = canvas!.clientWidth || 1
      const h = canvas!.clientHeight || 1
      canvas!.width = Math.max(1, Math.round(w * dpr))
      canvas!.height = Math.max(1, Math.round(h * dpr))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      stars = makeStars(STAR_COUNT, w, h)
      if (reduced) drawStarfield(ctx!, w, h, stars, performance.now())
    }

    function loop(t: number) {
      drawStarfield(ctx!, canvas!.clientWidth || 1, canvas!.clientHeight || 1, stars, t)
      raf = requestAnimationFrame(loop)
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    if (!reduced) raf = requestAnimationFrame(loop)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className="h-full w-full" />
}

export default function Background() {
  const { data } = useQuery({
    queryKey: ['background'],
    queryFn: () => api.settings.background.get(),
  })
  // Loading (data undefined) degrades to the bare wrapper — same visual as
  // `solid` — rather than guessing a variant, so nothing flashes in/out once
  // the real preference resolves.
  const variant: BackgroundVariant | undefined = data?.variant

  // `blobs` reuses the intact <Ambient/> (position:fixed) inside a passthrough
  // shell with no `.ambient` class → uniform testid contract, no double-paint.
  if (variant === 'blobs') {
    return (
      <div data-testid="app-background" data-variant="blobs" aria-hidden>
        <Ambient />
      </div>
    )
  }

  return (
    <div data-testid="app-background" data-variant={variant ?? 'solid'} className="ambient" aria-hidden>
      {variant === 'galaxy' && <GalaxyCanvas />}
      {variant === 'aurora' && <div className="lg-aurora h-full w-full" />}
    </div>
  )
}
