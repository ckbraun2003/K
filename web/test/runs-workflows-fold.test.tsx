/** UI Simplification Task 16 — RunsPage slims to master-detail only. The former
 *  Workflows fold (SegControl + workflows branch, P4 C1) is REMOVED: Automations now
 *  lives under the Agents hub (AutomationsView mounted as a tab — agents-ia.test.tsx).
 *  RunsPage takes only `runId` (Shell already passes just that — Task 10); this
 *  locks the slimmed shape has no leftover fold surface (no SegControl, no
 *  Automations mount, no special-cased 'workflows' runId branch). */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('../src/components/RunList', () => ({ default: () => <div data-testid="run-list" /> }))
vi.mock('../src/components/RunConsole', () => ({ default: (p: { runId: string }) => <div data-testid="run-console">{p.runId}</div> }))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import RunsPage from '../src/pages/RunsPage'

afterEach(() => cleanup())

describe('RunsPage — slimmed to master-detail only', () => {
  it('renders the run list + empty-detail state with no runId', () => {
    render(<RunsPage />)
    expect(screen.getByTestId('run-list')).toBeTruthy()
    expect(screen.queryByTestId('run-console')).toBeNull()
  })

  it('a runId renders the run console', () => {
    render(<RunsPage runId="run-abc" />)
    expect(screen.getByTestId('run-console').textContent).toBe('run-abc')
  })

  it('has no leftover SegControl / Workflows surface (the fold moved to Agents/Automations)', () => {
    render(<RunsPage runId="workflows" />)
    // 'workflows' is just an ordinary (nonexistent) runId now — no special branch.
    expect(screen.queryByTestId('seg-runs')).toBeNull()
    expect(screen.queryByTestId('seg-workflows')).toBeNull()
    expect(screen.getByTestId('run-console').textContent).toBe('workflows')
  })
})
