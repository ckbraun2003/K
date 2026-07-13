/** P4 B1 — Org roster/tree/graph shell: defaults roster, deep-links a segment. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
vi.mock('../src/pages/org/RosterView', () => ({ default: () => <div data-testid="seg-body-roster" /> }))
vi.mock('../src/pages/org/TreeView', () => ({ default: () => <div data-testid="seg-body-tree" /> }))
vi.mock('../src/pages/org/GraphView', () => ({ default: () => <div data-testid="seg-body-graph" /> }))
import OrgPage from '../src/pages/OrgPage'
afterEach(() => cleanup())

// P5-B: OrgPage now renders a read-only autonomy status chip (useQuery), so every
// render needs a QueryClientProvider ancestor — the chip's own content is covered
// separately in autonomy-settings.test.tsx.
function renderPage(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('OrgPage', () => {
  it('defaults to Roster and marks its segment pressed', () => {
    renderPage(<OrgPage />)
    expect(screen.getByTestId('seg-body-roster')).toBeTruthy()
    expect(screen.getByTestId('seg-roster').getAttribute('aria-pressed')).toBe('true')
  })
  it('deep-links the graph segment', () => {
    renderPage(<OrgPage seg="graph" />)
    expect(screen.getByTestId('seg-body-graph')).toBeTruthy()
  })
})
