/**
 * PipelinesView RunDetail — Artifacts panel (Lane B, runs-consolidation B4): a run's
 * Artifacts panel lists artifacts produced by its stages (fetched via the new
 * `api.pipelines.runArtifacts`, which the server joins on each stage's linked agent
 * runId → artifacts.linkedRunId), and clicking a row — or a matching ledger
 * 'artifact' row (stageKey → slug join, since a ledger 'artifact' entry itself only
 * carries a commit SHA) — opens the shared DocViewer modal. DocViewer's own
 * rendering is covered by doc-viewer.test.tsx; `api.artifacts.get` is stubbed here
 * just enough that the modal mounts without an unhandled rejection.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Artifact, PipelineLedgerEntry, PipelineRun, PipelineRunView } from '@k/shared'

const { mockListRuns, mockGetRun, mockLedger, mockRunArtifacts, mockGetArtifact } = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockGetRun: vi.fn(),
  mockLedger: vi.fn(),
  mockRunArtifacts: vi.fn(),
  mockGetArtifact: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    pipelines: {
      listRuns: mockListRuns,
      getRun: mockGetRun,
      cancel: vi.fn(),
      ledger: mockLedger,
      runArtifacts: mockRunArtifacts,
    },
    artifacts: {
      get: mockGetArtifact,
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
        id: 's1', pipelineRunId: 'pr1', stageKey: 'implement', kind: 'agent', status: 'passed',
        runId: 'r1', attempt: 1, maxAttempts: 1, repairs: 0, costUsd: null,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: 'abc123',
        startedAt: 0, completedAt: 1,
      },
    ],
    edges: [{ from: null, to: 'implement', handoff: 'share-tree', when: 'always' }],
  }
}
function artifactRow(): Omit<Artifact, 'md' | 'html'> {
  return { slug: 'doc-1', title: 'Design doc', tags: [], linkedRunId: 'r1', updatedAt: 1000, projectId: null, origin: 'compiled' }
}
function fullArtifact(): Artifact {
  return { ...artifactRow(), md: '# hi', html: '<p>hi</p>' }
}
function ledgerWithArtifactEntry(): PipelineLedgerEntry[] {
  return [
    {
      id: 'l1', pipelineRunId: 'pr1', stageKey: 'implement', seq: 1, ts: 1000,
      kind: 'artifact', actor: 'implementer', goal: null, detail: { resultCommit: 'abc123' }, cost: null,
    },
  ]
}

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineRunsPane selectedRunId="pr1" onSelectRun={() => {}} />
    </QueryClientProvider>,
  )
}

describe('RunDetail Artifacts panel (Lane B B4)', () => {
  it('lists artifacts fetched via api.pipelines.runArtifacts and opens the viewer on click', async () => {
    mockListRuns.mockResolvedValue([run()])
    mockGetRun.mockResolvedValue(view())
    mockLedger.mockResolvedValue([])
    mockRunArtifacts.mockResolvedValue([artifactRow()])
    mockGetArtifact.mockResolvedValue(fullArtifact())

    renderPane()

    await waitFor(() => expect(mockRunArtifacts).toHaveBeenCalledWith('pr1'))
    const row = await screen.findByTestId('pipeline-artifact-doc-1')
    expect(row.textContent).toContain('Design doc')

    fireEvent.click(row)
    expect(await screen.findByTestId('pipeline-artifact-viewer')).toBeTruthy()
    expect(screen.getByText('doc-1')).toBeTruthy()
  })

  it('renders an empty state when the run has no artifacts', async () => {
    mockListRuns.mockResolvedValue([run()])
    mockGetRun.mockResolvedValue(view())
    mockLedger.mockResolvedValue([])
    mockRunArtifacts.mockResolvedValue([])

    renderPane()

    await waitFor(() => expect(screen.getByTestId('pipeline-artifacts-empty')).toBeTruthy())
  })

  it('makes a matching ledger "artifact" row clickable and opens the same viewer', async () => {
    mockListRuns.mockResolvedValue([run()])
    mockGetRun.mockResolvedValue(view())
    mockRunArtifacts.mockResolvedValue([artifactRow()])
    mockLedger.mockResolvedValue(ledgerWithArtifactEntry())
    mockGetArtifact.mockResolvedValue(fullArtifact())

    renderPane()

    const ledgerRow = await screen.findByTestId('pipeline-ledger-entry-l1')
    // The stageKey→slug join depends on the artifacts fetch settling.
    await waitFor(() => expect(within(ledgerRow).getByText('view artifact')).toBeTruthy())

    fireEvent.click(ledgerRow)
    expect(await screen.findByTestId('pipeline-artifact-viewer')).toBeTruthy()
  })

  it('does not make an unmatched ledger "artifact" row clickable', async () => {
    mockListRuns.mockResolvedValue([run()])
    mockGetRun.mockResolvedValue(view())
    mockRunArtifacts.mockResolvedValue([]) // nothing produced — no join match
    mockLedger.mockResolvedValue(ledgerWithArtifactEntry())

    renderPane()

    const ledgerRow = await screen.findByTestId('pipeline-ledger-entry-l1')
    await waitFor(() => expect(mockRunArtifacts).toHaveBeenCalled())
    expect(within(ledgerRow).queryByText('view artifact')).toBeNull()
  })
})
