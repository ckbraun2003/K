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
  it('covers every LG2 + code-viewer token frozen at W0.2 (impressive-wave contract)', () => {
    for (const t of ['--lg-blob-1', '--lg-blob-2', '--lg-blob-3', '--lg-blob-4',
      '--lg-edge', '--lg-sheen',
      '--code-keyword', '--code-type', '--code-function', '--code-string',
      '--code-comment', '--code-number', '--code-operator', '--code-punctuation',
      '--code-property', '--code-tag', '--code-attr']) {
      expect(TOKEN_FALLBACKS[t], t).toBeTruthy()
    }
  })
})
