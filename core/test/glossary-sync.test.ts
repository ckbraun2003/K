// core/test/glossary-sync.test.ts — string-compare the generated web module to the
// re-rendered section; no cross-package import (only fs reads + core's own glossary.ts).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractGlossary, renderGlossaryModule } from '../src/glossary.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))          // core/test
const SECTION = path.resolve(HERE, '..', '..', 'artifacts', 'bible', 'sections', '14-glossary.md')
const GENERATED = path.resolve(HERE, '..', '..', 'web', 'src', 'generated', 'glossary.ts')

describe('generated glossary stays in sync with the bible section', () => {
  it('web/src/generated/glossary.ts === renderGlossaryModule(extractGlossary(section)) — run `pnpm bible` if this fails', () => {
    const expected = renderGlossaryModule(extractGlossary(fs.readFileSync(SECTION, 'utf8')))
    const actual = fs.readFileSync(GENERATED, 'utf8')
    expect(actual.replace(/\r\n/g, '\n')).toBe(expected.replace(/\r\n/g, '\n'))  // CRLF-tolerant
  })
})
