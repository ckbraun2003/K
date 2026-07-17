/**
 * Pure canvas draw helpers for the `galaxy` background variant
 * (usability-access B.4). Kept separate from Background.tsx so the star-field
 * math is unit-testable against a mock 2D context without mounting a
 * component or a real `<canvas>` element.
 *
 * Colors are resolved via `readToken()` (lib/tokens.ts) — the same
 * CSS-var-with-jsdom-fallback bridge the graph/health canvases already use —
 * never hardcoded here, so the starfield always tracks the live theme tokens
 * and this file stays clean under the raw-hex ui-token gate.
 */
import { readToken } from './tokens'

export interface Star {
  x: number     // px, within [0, w)
  y: number     // px, within [0, h)
  z: number     // depth in [0.2, 1] — drives size, brightness, drift speed
  phase: number // twinkle phase offset, radians
}

// Deterministic hash (no Math.random) so the SAME (count, w, h) always
// produces the SAME field — draw output stays reproducible for tests.
function hash(n: number): number {
  const v = Math.sin(n * 12.9898) * 43758.5453
  return v - Math.floor(v)
}

/** Deterministic star field: each star's own loop index seeds its hash, so
 *  repeated calls with the same (count, w, h) always yield the same field. */
export function makeStars(count: number, w: number, h: number): Star[] {
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    stars.push({
      x: hash(i * 1.618034 + 1) * w,
      y: hash(i * 2.718282 + 7) * h,
      z: 0.2 + hash(i * 3.141593 + 13) * 0.8,
      phase: hash(i * 1.414214 + 29) * Math.PI * 2,
    })
  }
  return stars
}

/** Pure draw at time `t` (ms): clears + fills the deep background, then plots
 *  each star with depth-based horizontal drift, twinkle and size. No
 *  randomness of its own — the same (ctx, w, h, stars, t) always issues the
 *  same sequence of canvas calls, so a mock 2D context can assert draw
 *  counts deterministically. */
export function drawStarfield(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stars: Star[],
  t: number,
): void {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = readToken('--bg-deep')
  ctx.fillRect(0, 0, w, h)

  const starColor = readToken('--text')
  for (const star of stars) {
    // Nearer stars (z→1) drift faster — cheap parallax, no per-star state.
    const drift = (t * 0.00002 * star.z) % 1
    const x = ((star.x / w + drift) % 1) * w
    const twinkle = 0.5 + 0.5 * Math.sin(t * 0.0016 + star.phase)
    const radius = 0.4 + star.z * 1.4
    ctx.globalAlpha = 0.3 + star.z * 0.5 * twinkle
    ctx.fillStyle = starColor
    ctx.beginPath()
    ctx.arc(x, star.y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
