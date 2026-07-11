/** UI Simplification Task 10 — the rail is exactly the 6-tab primary IA (Home/
 *  Personal/Agents/Runs/Insights/Projects) + Help/Settings footer + a hidden
 *  section that keeps deep-link titles only (docs, skill-creator, timeline). */
import { describe, it, expect } from 'vitest'
import { DESTINATIONS } from '../src/shell/Sidebar'

const primary = DESTINATIONS.filter(d => d.section === 'primary').map(d => d.id)
const footer = DESTINATIONS.filter(d => d.section === 'footer').map(d => d.id)

describe('P4 UI-Simpl rail (Task 10: 6-rail IA)', () => {
  it('primary rail is exactly the 6-tab order', () => {
    expect(primary).toEqual(['home', 'personal', 'agents', 'runs', 'insights', 'projects'])
  })
  it('footer is Help + Settings', () => {
    expect(footer).toEqual(['help', 'settings'])
  })
  it('hidden section keeps deep-link titles only (docs, skill-creator, timeline)', () => {
    expect(DESTINATIONS.filter(d => d.section === 'hidden').map(d => d.id).sort())
      .toEqual(['docs', 'skill-creator', 'timeline'])
  })
})
