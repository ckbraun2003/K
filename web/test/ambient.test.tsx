import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '@testing-library/react'
import Ambient from '../src/shell/Ambient'

describe('Ambient (LG2 living layer)', () => {
  it('renders the aria-hidden container with four drifting blobs', () => {
    const { container } = render(<Ambient />)
    const root = container.firstElementChild!
    expect(root.className).toContain('ambient')
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.querySelectorAll('.ambient-blob').length).toBe(4)
  })

  // Reduced-motion must FREEZE the blobs (drop the animation), not remove them
  // from the DOM — jsdom doesn't evaluate real @media cascades against an
  // external stylesheet, so this asserts the freeze mechanism statically:
  // the prefers-reduced-motion block in index.css must still target
  // .ambient-blob (easy regression once that class exists — the pre-W0.3
  // block only listed .ambient, .glow-live).
  it('freezes .ambient-blob (not just .ambient) under prefers-reduced-motion', () => {
    const css = readFileSync(join(__dirname, '../src/index.css'), 'utf8')

    // index.css has more than one `@media (prefers-reduced-motion: reduce)`
    // block (the .shimmer one, and this component's), so a naive non-greedy
    // regex can latch onto the wrong one. Walk brace depth to extract every
    // such block precisely, then search across all of them.
    const blocks: string[] = []
    const marker = '@media (prefers-reduced-motion: reduce)'
    let searchFrom = 0
    for (;;) {
      const at = css.indexOf(marker, searchFrom)
      if (at === -1) break
      const open = css.indexOf('{', at)
      let depth = 1
      let i = open + 1
      while (depth > 0 && i < css.length) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        i++
      }
      blocks.push(css.slice(open + 1, i - 1))
      searchFrom = i
    }
    expect(blocks.length, 'no prefers-reduced-motion block found in index.css').toBeGreaterThan(0)

    // Within each block, parse `selector, selector { body }` rules and find
    // the one whose selector list contains .ambient-blob — then assert its
    // body actually freezes the animation.
    const allRules = blocks.flatMap(block => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
    const blobRule = allRules.find(([, selectors]) =>
      selectors.split(',').map(s => s.trim()).includes('.ambient-blob'),
    )
    expect(blobRule, '.ambient-blob not found in any reduced-motion rule').toBeTruthy()
    expect(blobRule![2]).toMatch(/animation:\s*none/)
  })
})
