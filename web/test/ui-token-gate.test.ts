// web/test/ui-token-gate.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import allowlist from './ui-token-allowlist.json'

const SRC = join(__dirname, '..', 'src')
const RAW_TW = /\b(?:text|bg|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|divide|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
// Longest-first so 8/4-digit alpha hex can't slip past via a partial 6/3-digit
// match whose \b then fails; 5/7/9+ hex runs (e.g. #<short-sha> fragments) stay
// unmatched because every alternative demands a word boundary right after it.
const RAW_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/
const EXEMPT = new Set(['lib/tokens.ts'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(f) ? [p] : []
  })
}

describe('ui token gate', () => {
  const files = walk(SRC)
    .map((p) => relative(SRC, p).replaceAll('\\', '/'))
    .filter((p) => p !== 'index.css' && !EXEMPT.has(p) && !allowlist.includes(p))

  it.each(files)('%s uses tokens, not raw palette/hex', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8')
    expect(src).not.toMatch(RAW_TW)
    expect(src).not.toMatch(RAW_HEX)
  })

  it('allowlist only lists files that still exist and still violate', () => {
    for (const rel of allowlist as string[]) {
      const src = readFileSync(join(SRC, rel), 'utf8')
      expect(RAW_TW.test(src) || RAW_HEX.test(src), `${rel} is clean — remove it from the allowlist`).toBe(true)
    }
  })
})
