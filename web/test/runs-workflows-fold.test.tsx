/** P4 C1 — RunsPage folds Workflows behind a SegControl. Mock the children to testids. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('../src/pages/runs/WorkflowsView', () => ({
  default: (p: { defId?: string }) => <div data-testid="workflows-view">defId:{p.defId ?? 'none'}</div>,
}))
vi.mock('../src/components/RunList', () => ({ default: () => <div data-testid="run-list" /> }))
vi.mock('../src/components/RunConsole', () => ({ default: (p: { runId: string }) => <div data-testid="run-console">{p.runId}</div> }))
// Inlined vi.fn() (not a top-level const) — vi.mock is hoisted above module-scope
// vars, so referencing an outer `const mockNavigate` here throws "before
// initialization". No test asserts on navigate; the mock only keeps it callable.
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import RunsPage from '../src/pages/RunsPage'

afterEach(() => cleanup())

describe('RunsPage fold', () => {
  it('renders master-detail with the Runs segment pressed by default', () => {
    render(<RunsPage />)
    expect(screen.getByTestId('run-list')).toBeTruthy()
    expect(screen.getByTestId('seg-runs').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('seg-workflows').getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('workflows-view')).toBeNull()
  })
  it('runId=workflows renders WorkflowsView with the Workflows segment pressed', () => {
    render(<RunsPage runId="workflows" />)
    expect(screen.getByTestId('workflows-view')).toBeTruthy()
    expect(screen.getByTestId('seg-workflows').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('workflows-view').textContent).toContain('defId:none')
  })
  it('runId=workflows + sub passes defId through to WorkflowsView', () => {
    render(<RunsPage runId="workflows" sub="def-1" />)
    expect(screen.getByTestId('workflows-view').textContent).toContain('defId:def-1')
  })
  it('a real runId renders the run console (master-detail), not workflows', () => {
    render(<RunsPage runId="run-abc" />)
    expect(screen.getByTestId('run-console').textContent).toBe('run-abc')
    expect(screen.getByTestId('seg-runs').getAttribute('aria-pressed')).toBe('true')
  })
})
