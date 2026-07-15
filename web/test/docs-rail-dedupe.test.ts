import { describe, it, expect } from 'vitest'
import { disambiguateRailRows } from '../src/lib/artifact-rows'

const row = (slug: string, title: string) =>
  ({ slug, title, tags: [], updatedAt: 0 })

describe('disambiguateRailRows (DF-5)', () => {
  it('appends the slug to rows whose titles collide', () => {
    const rows = disambiguateRailRows([row('project-bible', 'K — Project Bible'), row('project-abc-bible', 'K — Project Bible')])
    expect(rows[0].railLabel).toBe('K — Project Bible · project-bible')
    expect(rows[1].railLabel).toBe('K — Project Bible · project-abc-bible')
  })
  it('leaves unique titles untouched', () => {
    expect(disambiguateRailRows([row('ui-demo', 'K — UI Demo')])[0].railLabel).toBe('K — UI Demo')
  })
})
