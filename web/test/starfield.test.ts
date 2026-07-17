/**
 * Pure starfield draw helpers (usability-access B.4) — determinism of
 * makeStars() and the exact canvas call sequence drawStarfield() issues
 * against a mock 2D context. No real canvas/DOM needed (node environment).
 */
import { describe, it, expect, vi } from 'vitest'
import { makeStars, drawStarfield } from '../src/lib/starfield'

function mockCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D
}

describe('makeStars', () => {
  it('is deterministic: same (count, w, h) yields the same field', () => {
    const a = makeStars(50, 800, 600)
    const b = makeStars(50, 800, 600)
    expect(a).toEqual(b)
  })

  it('produces exactly `count` stars, all within bounds', () => {
    const stars = makeStars(30, 400, 300)
    expect(stars).toHaveLength(30)
    for (const s of stars) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThan(400)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThan(300)
      expect(s.z).toBeGreaterThanOrEqual(0.2)
      expect(s.z).toBeLessThanOrEqual(1)
    }
  })

  it('differs between distinct dimensions (not a constant field)', () => {
    const a = makeStars(20, 800, 600)
    const b = makeStars(20, 400, 300)
    expect(a).not.toEqual(b)
  })
})

describe('drawStarfield', () => {
  it('clears + fills the background once, then draws one arc+fill per star', () => {
    const ctx = mockCtx()
    const stars = makeStars(12, 200, 150)
    drawStarfield(ctx, 200, 150, stars, 0)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 200, 150)
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)
    expect(ctx.beginPath).toHaveBeenCalledTimes(12)
    expect(ctx.arc).toHaveBeenCalledTimes(12)
    expect(ctx.fill).toHaveBeenCalledTimes(12)
  })

  it('is pure: identical (stars, w, h, t) draws the same call sequence twice', () => {
    const stars = makeStars(8, 200, 150)
    const ctxA = mockCtx()
    const ctxB = mockCtx()
    drawStarfield(ctxA, 200, 150, stars, 500)
    drawStarfield(ctxB, 200, 150, stars, 500)
    expect((ctxA.arc as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      (ctxB.arc as ReturnType<typeof vi.fn>).mock.calls,
    )
  })

  it('leaves globalAlpha reset to 1 after drawing', () => {
    const ctx = mockCtx()
    const stars = makeStars(5, 100, 100)
    drawStarfield(ctx, 100, 100, stars, 0)
    expect(ctx.globalAlpha).toBe(1)
  })
})
