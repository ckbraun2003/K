import { describe, it, expect } from 'vitest'
import { weightBand } from '../src/lib/capability-tokens'

describe('weightBand (relative — no dollars, no price)', () => {
  it('bands relative to the catalog max: <1/3 light, <2/3 medium, else heavy', () => {
    expect(weightBand(100, 900)).toBe('light')   // ~0.11
    expect(weightBand(400, 900)).toBe('medium')  // ~0.44
    expect(weightBand(800, 900)).toBe('heavy')   // ~0.89
    expect(weightBand(900, 900)).toBe('heavy')
  })
  it('null estTokens → null band; refMax 0 → light (avoid divide-by-zero)', () => {
    expect(weightBand(null, 900)).toBeNull()
    expect(weightBand(0, 0)).toBe('light')
  })
})
