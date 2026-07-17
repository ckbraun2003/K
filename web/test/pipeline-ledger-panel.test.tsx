/**
 * PipelineLedgerPanel (orch-p2 C.3) — the append-only progress ledger for one
 * pipeline run (design §6.1): a timeline of transitions/notes/cost/artifact/
 * iteration/gate entries, per-stage cost, and a loop iteration counter. Live via
 * the app-wide `pipeline_update.ledgerSeq` cursor (see live-invalidate.test.ts) —
 * this component just renders whatever `['pipeline-ledger', runId]` holds.
 * `api.pipelines.ledger` is mocked (vi.hoisted) — Lane A's route isn't landed yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PipelineLedgerEntry } from '@k/shared'

const { mockLedger } = vi.hoisted(() => ({ mockLedger: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: { pipelines: { ledger: mockLedger } },
}))

import PipelineLedgerPanel from '../src/components/PipelineLedgerPanel'

const ENTRIES: PipelineLedgerEntry[] = [
  { id: 'l1', pipelineRunId: 'pr1', stageKey: 'implement', seq: 1, ts: 1000, kind: 'transition', actor: 'implementer', goal: 'Implement the fix', detail: undefined, cost: null },
  { id: 'l2', pipelineRunId: 'pr1', stageKey: 'verify', seq: 2, ts: 2000, kind: 'iteration', actor: null, goal: null, detail: { iteration: 2 }, cost: null },
  { id: 'l3', pipelineRunId: 'pr1', stageKey: 'implement', seq: 3, ts: 3000, kind: 'cost', actor: 'implementer', goal: null, detail: undefined, cost: 0.0421 },
  { id: 'l4', pipelineRunId: 'pr1', stageKey: 'gate-clean', seq: 4, ts: 4000, kind: 'gate', actor: null, goal: 'Awaiting review', detail: undefined, cost: null },
]

beforeEach(() => {
  mockLedger.mockReset()
  mockLedger.mockResolvedValue(ENTRIES)
})
afterEach(() => cleanup())

function renderPanel(runId = 'pr1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineLedgerPanel runId={runId} />
    </QueryClientProvider>,
  )
}

describe('PipelineLedgerPanel', () => {
  it('fetches and renders every ledger entry in seq order with its stage/kind/actor', async () => {
    renderPanel()
    expect(mockLedger).toHaveBeenCalledWith('pr1')

    const rows = await screen.findAllByTestId(/^pipeline-ledger-entry-/)
    expect(rows).toHaveLength(4)
    expect(rows.map(r => r.getAttribute('data-testid'))).toEqual([
      'pipeline-ledger-entry-l1',
      'pipeline-ledger-entry-l2',
      'pipeline-ledger-entry-l3',
      'pipeline-ledger-entry-l4',
    ])
    expect(screen.getByTestId('pipeline-ledger-entry-l1').textContent).toContain('implementer')
    expect(screen.getByTestId('pipeline-ledger-entry-l4').textContent).toContain('Awaiting review')
  })

  it('shows the measured per-stage cost and the loop iteration counter', async () => {
    renderPanel()
    await screen.findByTestId('pipeline-ledger-entry-l1')

    expect(screen.getByTestId('pipeline-ledger-entry-l3').textContent).toMatch(/0\.0421|\$0\.04/)
    expect(screen.getByTestId('pipeline-ledger-entry-l2').textContent).toContain('2')
  })

  it('renders an empty state when the run has no ledger entries yet', async () => {
    mockLedger.mockReset()
    mockLedger.mockResolvedValue([])
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('pipeline-ledger-empty')).toBeTruthy())
  })

  it('surfaces an error state with retry on fetch failure', async () => {
    mockLedger.mockReset()
    mockLedger.mockRejectedValue(new Error('boom'))
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('pipeline-ledger-error')).toBeTruthy())
  })
})
