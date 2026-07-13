// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readToken, TOKEN_FALLBACKS } from '../src/lib/tokens'

describe('tokens', () => {
  it('falls back to the canonical map when CSS vars are absent (jsdom)', () => {
    expect(readToken('--chart-1')).toBe('#ff8fc0')
    expect(readToken('--red')).toBe('#f87171')
  })
  it('fallback map covers every canvas consumer token', () => {
    for (const t of ['--green', '--amber', '--red', '--muted', '--chart-other',
      '--chart-1', '--chart-2', '--chart-3', '--chart-4']) {
      expect(TOKEN_FALLBACKS[t], t).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
