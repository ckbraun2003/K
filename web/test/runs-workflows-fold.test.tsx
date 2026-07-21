/** UI Simplification Task 16 established RunsPage as a slimmed master-detail-only
 *  page (no SegControl). Lane B (runs consolidation, B1) reverses that specific
 *  point: the Automations "Runs" segment (PipelineRunsPane) relocates onto the
 *  Runs page as a NEW top-level "Agent Runs | Pipelines" SegControl — this file
 *  now locks THAT shape instead. RunsPage takes `param`/`subParam` (Shell passes
 *  both — B2); `param==='pipelines'` selects the Pipelines segment (a reserved
 *  runs-param keyword, mirroring how 'workflows' used to be reserved), otherwise
 *  `param` is treated as the selected agent-run id (unchanged master-detail
 *  behavior) and `subParam` carries the selected pipeline run id. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('../src/components/RunList', () => ({ default: () => <div data-testid="run-list" /> }))
vi.mock('../src/components/RunConsole', () => ({ default: (p: { runId: string }) => <div data-testid="run-console">{p.runId}</div> }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))
vi.mock('../src/pages/runs/PipelinesView', () => ({
  PipelineRunsPane: (p: { selectedRunId?: string; onSelectRun: (id: string) => void }) => (
    <div data-testid="pipeline-runs-pane-mock">
      <span>selectedRunId:{p.selectedRunId ?? 'none'}</span>
      <button type="button" data-testid="pipeline-runs-pane-select" onClick={() => p.onSelectRun('prun-1')}>
        select
      </button>
    </div>
  ),
}))

import RunsPage from '../src/pages/RunsPage'

afterEach(() => { cleanup(); mockNavigate.mockClear() })

describe('RunsPage — Agent Runs | Pipelines segmented control (Lane B B1)', () => {
  it('defaults to the Agent Runs segment: run list + empty-detail state, no param', () => {
    render(<RunsPage />)
    expect(screen.getByTestId('seg-agent').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('run-list')).toBeTruthy()
    expect(screen.queryByTestId('run-console')).toBeNull()
    expect(screen.queryByTestId('pipeline-runs-pane-mock')).toBeNull()
  })

  it('a non-"pipelines" param renders the run console on the Agent Runs segment', () => {
    render(<RunsPage param="run-abc" />)
    expect(screen.getByTestId('seg-agent').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('run-console').textContent).toBe('run-abc')
  })

  it("param='pipelines' selects the Pipelines segment and threads subParam as the selected pipeline run", () => {
    render(<RunsPage param="pipelines" subParam="prun-7" />)
    expect(screen.getByTestId('seg-pipelines').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('run-list')).toBeNull()
    expect(screen.getByTestId('pipeline-runs-pane-mock').textContent).toContain('selectedRunId:prun-7')
  })

  it('clicking the Pipelines segment navigates to runs/pipelines', () => {
    render(<RunsPage />)
    fireEvent.click(screen.getByTestId('seg-pipelines'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'pipelines')
  })

  it('clicking the Agent Runs segment (from Pipelines) navigates back to a bare runs param', () => {
    render(<RunsPage param="pipelines" />)
    fireEvent.click(screen.getByTestId('seg-agent'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', undefined)
  })

  it('selecting a pipeline run from the pane navigates to runs/pipelines/<id>', () => {
    render(<RunsPage param="pipelines" />)
    fireEvent.click(screen.getByTestId('pipeline-runs-pane-select'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'pipelines', 'prun-1')
  })
})
