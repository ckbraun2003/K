/**
 * P3 measured-cost gate (D-087): no price-coupled estimation may enter the app.
 * FAILS if a price-per-token table, a hardcoded $/token constant, or price*tokens
 * math appears in core/src or web/src. Matches IDENTIFIERS + the multiply pattern,
 * NOT display-only "$/run" labels or format divisions (/1000, /1_000_000) which are
 * legitimate roll-ups of measured cost. This test scans SOURCE only (never itself).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOTS = [
  path.resolve(HERE, '..', 'src'),              // core/src
  path.resolve(HERE, '..', '..', 'web', 'src'), // web/src
]
// Identifier + math signatures for PRICE-COUPLED estimation. Case-insensitive.
const FORBIDDEN: RegExp[] = [
  /price[_-]?per[_-]?token/i,
  /cost[_-]?per[_-]?token/i,
  /(input|output|prompt|completion|token|model)[_-]?price/i,
  /price[_-]?(table|map|list|per|book)/i,
  /per[_-]?(1k|1000|million|mtok|1m)[_-]?tokens?/i,
  /usd[_-]?per[_-]?token/i,
  /\btokens?\b[^\n;]{0,40}\*[^\n;]{0,40}\bprice\b/i,   // tokens ... * ... price
  /\bprice\b[^\n;]{0,40}\*[^\n;]{0,40}\btokens?\b/i,   // price ... * ... tokens
]

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.gitnexus') continue
      out.push(...walk(full))
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

describe('no price-coupled estimation (D-087 grep gate)', () => {
  it('core/src and web/src contain no price-per-token table or price*tokens math', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = fs.readFileSync(file, 'utf8')
        text.split('\n').forEach((line, i) => {
          for (const re of FORBIDDEN) {
            if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
          }
        })
      }
    }
    expect(hits, `price-coupled estimation is forbidden (measured actuals only):\n${hits.join('\n')}`).toEqual([])
  })
})
