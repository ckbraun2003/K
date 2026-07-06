/**
 * token-estimate.ts — the chars/4 heuristic seam (host-integration Wave 0).
 *
 * Pure-function contract: ceil(length/4), 0 for empty, UTF-16 code-unit length
 * (astral chars count 2). These boundaries are the frozen contract every est_*
 * consumer (catalog chips, capability summary, run-assets estTokens) sums over.
 */
import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../src/token-estimate.js'

describe('estimateTokens — boundaries', () => {
  it('empty string → 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('1..4 chars → 1 (ceil, not round)', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('ab')).toBe(1)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('5 chars → 2 (the ceil boundary)', () => {
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('exact multiples stay exact: 8 → 2, 4000 → 1000', () => {
    expect(estimateTokens('x'.repeat(8))).toBe(2)
    expect(estimateTokens('x'.repeat(4000))).toBe(1000)
  })

  it('always a non-negative integer', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(1234)]) {
      const n = estimateTokens(s)
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('estimateTokens — unicode (UTF-16 code-unit length)', () => {
  it('an astral emoji counts as 2 code units', () => {
    const emoji = '\u{1F600}' // 😀 — a surrogate pair
    expect(emoji.length).toBe(2)
    expect(estimateTokens(emoji)).toBe(1) // ceil(2/4)
    expect(estimateTokens(emoji.repeat(2))).toBe(1) // ceil(4/4)
    expect(estimateTokens(emoji.repeat(3))).toBe(2) // ceil(6/4)
  })

  it('BMP non-Latin text counts 1 code unit per char', () => {
    const jp3 = '日本語' // 日本語
    expect(estimateTokens(jp3)).toBe(1) // ceil(3/4)
    expect(estimateTokens(jp3 + 'のテキスト')).toBe(2) // ceil(8/4)
  })

  it('combining marks count as their own code units', () => {
    const combined = 'é'.repeat(4) // e + combining acute (decomposed) → 8 units
    expect(combined.length).toBe(8)
    expect(estimateTokens(combined)).toBe(2)
  })
})
