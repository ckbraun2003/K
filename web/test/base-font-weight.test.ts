// web/test/base-font-weight.test.ts
// ui-adjustments R4 (D-135): the base html/body/#root rule carries a slightly
// heavier default weight (450) than the browser default (400) for legibility
// against the glass surfaces. Asserted by reading index.css as text since the
// rule is plain CSS, not a component under test.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('base font weight', () => {
  it('html, body, #root carries font-weight: 450', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'index.css'), 'utf8')
    const match = css.match(/html,\s*body,\s*#root\s*\{([^}]*)\}/)
    expect(match, 'html, body, #root rule not found in index.css').toBeTruthy()
    expect(match![1]).toMatch(/font-weight:\s*450;/)
  })
})
