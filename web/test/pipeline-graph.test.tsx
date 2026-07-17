/**
 * PipelineGraph (D-119 C3, rewritten on @xyflow/react — usability-access P2.6 Lane A
 * task A.3). Light render smoke: mounts a small PipelineRunView, asserts a node per
 * stage + the synthetic `done` sink render, and that clicking a stage node reports
 * selection via `onSelectStage`. The load-bearing layout logic (positions, edge
 * retargeting) is covered by `pipeline-layout.test.ts`; React Flow's own internals
 * (pan/zoom/minimap) aren't re-tested here.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { PipelineRunView } from '@k/shared'
import PipelineGraph, { stageCanonical, EDGE_COLOR, isGate } from '../src/components/PipelineGraph'

beforeAll(() => {
  // @xyflow/react needs ResizeObserver in jsdom
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any
})
afterEach(() => cleanup())

function view(): PipelineRunView {
  return {
    run: {
      id: 'pr1', definitionId: 'd1', projectId: null, title: 'Ship it',
      status: 'running', createdAt: 0, updatedAt: 0, completedAt: null, ownerProfileId: null,
    },
    stages: [
      {
        id: 's1', pipelineRunId: 'pr1', stageKey: 'implement', kind: 'agent', status: 'passed',
        runId: 'r1', attempt: 1, maxAttempts: 1, repairs: 0, costUsd: 0.12,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: null,
        startedAt: 0, completedAt: 1,
      },
      {
        id: 's2', pipelineRunId: 'pr1', stageKey: 'review', kind: 'gate', status: 'awaiting_gate',
        runId: null, attempt: 1, maxAttempts: 1, repairs: 0, costUsd: null,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: null,
        startedAt: null, completedAt: null,
      },
    ],
    edges: [
      { from: null, to: 'implement', handoff: 'share-tree', when: 'always' },
      { from: 'implement', to: 'review', handoff: 'share-tree', when: 'pass' },
      { from: 'review', to: 'done', handoff: 'merge', when: 'pass' },
    ],
  }
}

describe('stageCanonical / EDGE_COLOR / isGate (kept exports)', () => {
  it('derives a canonical triple from stage.status when canonical is omitted', () => {
    const c = stageCanonical(view().stages[0])
    expect(c.state).toBe('done')
  })
  it('has a stroke color for every EdgeWhen', () => {
    expect(EDGE_COLOR.always).toBeTruthy()
    expect(EDGE_COLOR.pass).toBeTruthy()
    expect(EDGE_COLOR.fail).toBeTruthy()
    expect(EDGE_COLOR.repair).toBeTruthy()
    expect(EDGE_COLOR.loop).toBeTruthy()
  })
  it('flags a gate-kind or awaiting_gate stage', () => {
    expect(isGate(view().stages[1])).toBe(true)
    expect(isGate(view().stages[0])).toBe(false)
  })
})

describe('PipelineGraph render', () => {
  it('renders the DAG with a node tile per stage without throwing', () => {
    render(<PipelineGraph view={view()} />)
    expect(screen.getByTestId('pipeline-graph')).toBeTruthy()
    expect(screen.getByText('implement')).toBeTruthy()
    expect(screen.getByText('review')).toBeTruthy()
  })

  it('reports the clicked stage via onSelectStage', () => {
    const onSelect = vi.fn()
    render(<PipelineGraph view={view()} onSelectStage={onSelect} />)
    fireEvent.click(screen.getByText('implement'))
    expect(onSelect).toHaveBeenCalledWith('implement')
  })
})
