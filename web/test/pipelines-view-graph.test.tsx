/**
 * PipelinesView (usability-access P2.6 Lane A, task A.4) — a light smoke test that
 * `PipelineRunsPane`'s run-detail mounts the (now React-Flow-based) PipelineGraph
 * inside its sized container for a mocked `api.pipelines.getRun` view. React Flow
 * needs an explicit height on its parent to lay out — this locks that the wrapper
 * still renders the graph without throwing. The graph's own behavior (layout,
 * node/edge rendering, selection) is covered by pipeline-layout.test.ts,
 * pipeline-stage-node.test.tsx and pipeline-graph.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PipelineRun, PipelineRunView } from '@k/shared'

const { mockListRuns, mockGetRun } = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockGetRun: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    pipelines: {
      listRuns: mockListRuns,
      getRun: mockGetRun,
      cancel: vi.fn(),
    },
  },
}))

import { PipelineRunsPane } from '../src/pages/runs/PipelinesView'

beforeAll(() => {
  // @xyflow/react needs ResizeObserver in jsdom
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any
})
afterEach(() => cleanup())

function renderPane(selectedRunId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineRunsPane selectedRunId={selectedRunId} onSelectRun={() => {}} />
    </QueryClientProvider>,
  )
}

function run(): PipelineRun {
  return {
    id: 'pr1', definitionId: 'd1', projectId: null, title: 'Ship it',
    status: 'running', createdAt: 0, updatedAt: 0, completedAt: null, ownerProfileId: null,
  }
}
function view(): PipelineRunView {
  return {
    run: run(),
    stages: [
      {
        id: 's1', pipelineRunId: 'pr1', stageKey: 'implement', kind: 'agent', status: 'running',
        runId: 'r1', attempt: 1, maxAttempts: 1, repairs: 0, costUsd: null,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: null,
        startedAt: 0, completedAt: null,
      },
    ],
    edges: [{ from: null, to: 'implement', handoff: 'share-tree', when: 'always' }],
  }
}

describe('PipelinesView run detail — sized React Flow container', () => {
  it('mounts the pipeline graph for the selected run', async () => {
    mockListRuns.mockResolvedValue([run()])
    mockGetRun.mockResolvedValue(view())

    renderPane('pr1')

    await waitFor(() => expect(screen.getByTestId('pipeline-graph')).toBeTruthy())
    // scope to the graph container — the stage-cards list below also renders the
    // stageKey text, so an unscoped query would multi-match. waitFor the node itself:
    // React Flow can paint the container a tick before its node DOM.
    await waitFor(() =>
      expect(within(screen.getByTestId('pipeline-graph')).getByText('implement')).toBeTruthy(),
    )
  })
})
