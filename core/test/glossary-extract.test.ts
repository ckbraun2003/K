import { describe, it, expect } from 'vitest'
import { extractGlossary, renderGlossaryModule } from '../src/glossary.js'

const SECTION = `---
title: Glossary
---

# Glossary

Some intro prose that is not a term.

**Wave** — one implementer + reviewers producing a single reviewable commit.

**Park** — a run paused awaiting the operator (awaiting_input or awaiting_plan).

Not a term line.
`

describe('extractGlossary', () => {
  it('extracts bold-term — definition pairs, ignoring prose', () => {
    const terms = extractGlossary(SECTION)
    expect(terms).toEqual([
      { term: 'Wave', definition: 'one implementer + reviewers producing a single reviewable commit.' },
      { term: 'Park', definition: 'a run paused awaiting the operator (awaiting_input or awaiting_plan).' },
    ])
  })
  it('renderGlossaryModule emits a valid, sorted GLOSSARY record source', () => {
    const src = renderGlossaryModule([{ term: 'Zeta', definition: 'z' }, { term: 'Alpha', definition: 'a' }])
    expect(src).toContain('export const GLOSSARY: Record<string, string> =')
    expect(src.indexOf('Alpha')).toBeLessThan(src.indexOf('Zeta')) // deterministic (sorted) output
    expect(src).toContain('do not edit') // generated-file banner
  })
})
