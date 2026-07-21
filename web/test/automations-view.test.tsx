/**
 * AutomationsView (orch-p2 C.4, design §9/§6) — the unified Library | Schedules
 * surface that replaces the old Pipelines-tab SegControl toggle between
 * PipelinesView and the legacy WorkflowsView. This test locks:
 *   - default segment is Library; a `defId` deep-link still shows Library
 *     (mirrors the old always-legacy-editor deep-link, now routed to the
 *     Library pane's inspector instead of WorkflowsView)
 *   - switching segments swaps the mounted pane
 *   - a dispatch from Library hands off to the Runs page's Pipelines segment
 *     (Lane B B1 — the old in-page Runs segment/PipelineRunsPane was relocated
 *     onto RunsPage) and still shows a confirmation toast
 *   - Schedules renders an honest empty state today (pipelineDefId isn't
 *     populated by core/src/routes/routines.ts yet — Lane B's B.3)
 * `PipelineLibraryPane` (from PipelinesView.tsx) is mocked to a marker div —
 * its own internals are locked by pipeline-def-inspector tests elsewhere.
 * `navigate` (from lib/route) is mocked so the handoff can be asserted directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RoutineView } from '@k/shared'

const { mockRoutinesList, mockNavigate } = vi.hoisted(() => ({
  mockRoutinesList: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: { routines: { list: mockRoutinesList } },
}))

vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

vi.mock('../src/pages/runs/PipelinesView', () => ({
  PipelineLibraryPane: (p: { focusDefId?: string; onDispatched?: (id: string) => void }) => (
    <div data-testid="library-pane-mock">
      <span>focusDefId:{p.focusDefId ?? 'none'}</span>
      <button type="button" data-testid="library-pane-dispatch" onClick={() => p.onDispatched?.('run-9')}>
        dispatch
      </button>
    </div>
  ),
}))

import AutomationsView from '../src/pages/runs/AutomationsView'

function renderView(props: { defId?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AutomationsView {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockRoutinesList.mockReset()
  mockRoutinesList.mockResolvedValue([])
  mockNavigate.mockReset()
})
afterEach(() => cleanup())

describe('AutomationsView', () => {
  it('defaults to the Library segment', () => {
    renderView()
    expect(screen.getByTestId('seg-library').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('library-pane-mock')).toBeTruthy()
  })

  it('threads a defId deep-link into the Library pane as focusDefId, still on the Library segment', () => {
    renderView({ defId: 'def-1' })
    expect(screen.getByTestId('seg-library').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('library-pane-mock').textContent).toContain('focusDefId:def-1')
  })

  it('has no Runs segment (B1 — relocated onto the Runs page)', () => {
    renderView()
    expect(screen.queryByTestId('seg-runs')).toBeNull()
  })

  it('switches to the Schedules pane when the Schedules segment is clicked', async () => {
    renderView()
    fireEvent.click(screen.getByTestId('seg-schedules'))
    await waitFor(() => expect(screen.getByTestId('automations-schedules-empty')).toBeTruthy())
  })

  it('a Library dispatch hands off to Runs/Pipelines with the new run id and shows a toast', async () => {
    renderView()
    fireEvent.click(screen.getByTestId('library-pane-dispatch'))

    expect(mockNavigate).toHaveBeenCalledWith('runs', 'pipelines', 'run-9')
    await waitFor(() => expect(screen.getByTestId('pipeline-run-toast')).toBeTruthy())
  })

  it('Schedules lists only routines targeting a pipeline (pipelineDefId set), skipping plain schedule-skills', async () => {
    const routines: RoutineView[] = [
      { id: 'ro1', name: 'Nightly cleanup', enabled: true, schedule: '0 2 * * *', nextRunAt: null, lastRunAt: null, runs: 0, totalCostUsd: 0, pipelineDefId: 'def-1' },
      { id: 'ro2', name: 'Plain skill routine', enabled: true, schedule: '0 3 * * *', nextRunAt: null, lastRunAt: null, runs: 0, totalCostUsd: 0 },
    ]
    mockRoutinesList.mockResolvedValue(routines)
    renderView()
    fireEvent.click(screen.getByTestId('seg-schedules'))

    await waitFor(() => expect(screen.getByTestId('automations-schedule-ro1')).toBeTruthy())
    expect(screen.getByTestId('automations-schedule-ro1').textContent).toContain('Nightly cleanup')
    expect(screen.queryByTestId('automations-schedule-ro2')).toBeNull()
  })
})
