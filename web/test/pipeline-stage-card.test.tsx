/**
 * PipelineStageCard — Lane B B3: an "Open agent run" affordance appears whenever
 * `stage.runId` is set (the stage was dispatched to an agent), regardless of the
 * stage's settled/parked state, and navigates to that run's console. Absent a
 * `runId` (never dispatched, or the synthetic states with no linked agent run),
 * no such affordance renders. `api` is mocked since PipelineStageCard wires a
 * rewind mutation through it (unrelated to this affordance, but the module import
 * must resolve under vitest's mocked test environment).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PipelineStageRun } from '@k/shared'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))
vi.mock('../src/lib/api', () => ({ api: { pipelines: { rewindStage: vi.fn() } } }))

import PipelineStageCard from '../src/components/PipelineStageCard'

afterEach(() => { cleanup(); mockNavigate.mockClear() })

function stage(over: Partial<PipelineStageRun> = {}): PipelineStageRun {
  return {
    id: 's1', pipelineRunId: 'pr1', stageKey: 'implement', kind: 'agent', status: 'running',
    runId: null, attempt: 1, maxAttempts: 1, repairs: 0, costUsd: null, failureClass: null,
    gateNote: null, baseCommit: null, resultCommit: null, startedAt: 0, completedAt: null,
    ...over,
  }
}

function renderCard(s: PipelineStageRun) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineStageCard stage={s} runId="pr1" />
    </QueryClientProvider>,
  )
}

describe('PipelineStageCard — "Open agent run" affordance (Lane B B3)', () => {
  it('renders the affordance when the stage carries a linked agent run', () => {
    renderCard(stage({ runId: 'r1' }))
    expect(screen.getByTestId('pipeline-stage-open-agent-implement')).toBeTruthy()
  })

  it('navigates to the linked agent run on click', () => {
    renderCard(stage({ runId: 'r1' }))
    fireEvent.click(screen.getByTestId('pipeline-stage-open-agent-implement'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r1')
  })

  it('does not render the affordance when the stage has no linked agent run', () => {
    renderCard(stage({ runId: null }))
    expect(screen.queryByTestId('pipeline-stage-open-agent-implement')).toBeNull()
  })

  it('shows the affordance alongside the rewind action for a settled, linked stage', () => {
    renderCard(stage({ runId: 'r1', status: 'passed' }))
    expect(screen.getByTestId('pipeline-stage-open-agent-implement')).toBeTruthy()
    expect(screen.getByTestId('pipeline-stage-rewind-implement')).toBeTruthy()
  })
})
