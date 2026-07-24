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
  it('covers the Round 3 (D-134) color-by-role glass tokens with the locked palette values', () => {
    expect(TOKEN_FALLBACKS['--glass-1']).toBe('rgba(255, 255, 255, 0.035)')
    expect(TOKEN_FALLBACKS['--glass-2']).toBe('rgba(250, 238, 252, 0.06)')
    expect(TOKEN_FALLBACKS['--glass-3']).toBe('rgba(244, 222, 248, 0.095)')
    expect(TOKEN_FALLBACKS['--glass-4']).toBe('rgba(238, 210, 246, 0.145)')
    expect(TOKEN_FALLBACKS['--glass-icon']).toBe('rgba(226, 148, 224, 0.20)')
    expect(TOKEN_FALLBACKS['--glass-icon-strong']).toBe('rgba(226, 148, 224, 0.30)')
    expect(TOKEN_FALLBACKS['--icon-glyph']).toBe('#e7a8e4')
    expect(TOKEN_FALLBACKS['--glass-icon-edge']).toBe('rgba(226, 148, 224, 0.55)')
    expect(TOKEN_FALLBACKS['--glass-hover']).toBe('rgba(135, 206, 250, 0.18)')
    expect(TOKEN_FALLBACKS['--glass-active']).toBe('rgba(135, 206, 250, 0.30)')
    expect(TOKEN_FALLBACKS['--glass-active-edge']).toBe('rgba(135, 206, 250, 0.55)')
    expect(TOKEN_FALLBACKS['--glass-code']).toBe('rgba(16, 12, 26, 0.55)')
  })
  it('no longer carries the removed --terminal-bg token (terminal feature deleted, D-134)', () => {
    expect(TOKEN_FALLBACKS['--terminal-bg']).toBeUndefined()
  })
  it('covers the R4 (D-135) role anchors and the accent token now derived from --primary', () => {
    expect(TOKEN_FALLBACKS['--primary']).toBe('#e294e0')
    expect(TOKEN_FALLBACKS['--secondary']).toBe('#87cefa')
    // --accent unifies onto --primary (pink); --accent-hover/-hi are the resolved
    // color-mix(in srgb, --primary 72%/40%, white) values — concrete hex, never a
    // literal color-mix(...) string, since jsdom/canvas readers must resolve them directly.
    expect(TOKEN_FALLBACKS['--accent']).toBe('#e294e0')
    expect(TOKEN_FALLBACKS['--accent-hover']).toBe('#eab2e9')
    expect(TOKEN_FALLBACKS['--accent-hi']).toBe('#f3d4f3')
  })
})
