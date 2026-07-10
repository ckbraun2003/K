/** P4 W0c — the rail is exactly the 9-item IA (7 primary + 2 footer), correct order,
 *  merged/folded entries gone. */
import { describe, it, expect } from 'vitest'
import { DESTINATIONS, NAV_DESTINATIONS } from '../src/shell/Sidebar'

const primary = DESTINATIONS.filter(d => d.section === 'primary').map(d => d.id)
const footer = DESTINATIONS.filter(d => d.section === 'footer').map(d => d.id)

describe('P4 rail (E-29 14->9)', () => {
  it('primary rail is exactly the operator order', () => {
    expect(primary).toEqual(['home', 'org', 'projects', 'skills', 'runs', 'insights', 'inbox'])
  })
  it('footer is Help + Settings', () => {
    expect(footer).toEqual(['help', 'settings'])
  })
  it('the merged/folded rail entries are gone from primary', () => {
    for (const gone of ['chief', 'orchestrators', 'workflows', 'memory', 'graph', 'metrics', 'routing', 'evals', 'terminal'])
      expect(primary).not.toContain(gone)
  })
  it('K label and Org/Insights entries present', () => {
    expect(DESTINATIONS.find(d => d.id === 'home')?.label).toBe('K')
    expect(DESTINATIONS.find(d => d.id === 'org')?.section).toBe('primary')
    expect(DESTINATIONS.find(d => d.id === 'insights')?.section).toBe('primary')
  })
  it('command palette can still reach the demoted Memory (lessons) + Terminal deep-links', () => {
    const navIds = NAV_DESTINATIONS.map(d => d.id)
    expect(navIds).toContain('lessons')
    expect(navIds).toContain('terminal')
  })
})
