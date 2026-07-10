/** P4 B1 — Org roster/tree/graph shell: defaults roster, deep-links a segment. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
vi.mock('../src/pages/org/RosterView', () => ({ default: () => <div data-testid="seg-body-roster" /> }))
vi.mock('../src/pages/org/TreeView', () => ({ default: () => <div data-testid="seg-body-tree" /> }))
vi.mock('../src/pages/org/GraphView', () => ({ default: () => <div data-testid="seg-body-graph" /> }))
import OrgPage from '../src/pages/OrgPage'
afterEach(() => cleanup())

describe('OrgPage', () => {
  it('defaults to Roster and marks its segment pressed', () => {
    render(<OrgPage />)
    expect(screen.getByTestId('seg-body-roster')).toBeTruthy()
    expect(screen.getByTestId('seg-roster').getAttribute('aria-pressed')).toBe('true')
  })
  it('deep-links the graph segment', () => {
    render(<OrgPage seg="graph" />)
    expect(screen.getByTestId('seg-body-graph')).toBeTruthy()
  })
})
