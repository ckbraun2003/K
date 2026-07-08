/**
 * ImpactPanel (P1 C2, E-07) — blast-radius panel for a run's changed files.
 * Locks: unindexed → index CTA wired to api.projects.graphBuild (no button
 * without a projectId); indexed → risk chip + totals + per-file symbol chips
 * with dependents counts (symbol-less files dropped); indexed-but-empty →
 * renders nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunImpactPayload } from '@k/shared'

const { mockImpact, mockGraphBuild, wsHandlers } = vi.hoisted(() => ({
  mockImpact: vi.fn(),
  mockGraphBuild: vi.fn(),
  wsHandlers: [] as Array<(msg: unknown) => void>,
}))
vi.mock('../src/lib/api', () => ({
  api: { runs: { impact: mockImpact }, projects: { graphBuild: mockGraphBuild } },
}))
vi.mock('../src/lib/ws', () => ({
  onWsMessage: (h: (msg: unknown) => void) => {
    wsHandlers.push(h)
    return () => {
      const i = wsHandlers.indexOf(h)
      if (i >= 0) wsHandlers.splice(i, 1)
    }
  },
}))

import ImpactPanel from '../src/components/ImpactPanel'

function renderPanel(projectId: string | null = 'p1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ImpactPanel runId="r1" projectId={projectId} />
    </QueryClientProvider>,
  )
}

const UNINDEXED: RunImpactPayload = {
  indexed: false, projectId: 'p1', files: [], totalSymbols: 0, totalDependents: 0, risk: null,
}
const HIGH: RunImpactPayload = {
  indexed: true,
  projectId: 'p1',
  files: [
    {
      file: 'src/lib/store.ts',
      symbols: [
        { id: 's1', name: 'saveRun', type: 'function', dependents: 12 },
        { id: 's2', name: 'listRuns', type: 'function', dependents: 4 },
        { id: 's3', name: 'fmtRow', type: 'function', dependents: 0 },
      ],
    },
    { file: 'src/other.ts', symbols: [] },
  ],
  totalSymbols: 3,
  totalDependents: 16,
  risk: 'high',
}

beforeEach(() => {
  vi.clearAllMocks()
  wsHandlers.length = 0
  mockGraphBuild.mockResolvedValue({ status: 'building' })
})
afterEach(() => cleanup())

describe('ImpactPanel', () => {
  it('unindexed → CTA renders and the button triggers the graph-build wrapper', async () => {
    mockImpact.mockResolvedValue(UNINDEXED)
    renderPanel()
    const cta = await screen.findByTestId('impact-cta')
    expect(cta.textContent).toContain('Impact map needs a code index.')
    fireEvent.click(screen.getByText('Index this project'))
    await waitFor(() => expect(mockGraphBuild).toHaveBeenCalledWith('p1'))
    // once the build kicked off, the button locks as Indexing…
    expect(await screen.findByText('Indexing…')).toBeTruthy()
  })

  it('unindexed without a projectId → CTA text but no index button', async () => {
    mockImpact.mockResolvedValue(UNINDEXED)
    renderPanel(null)
    await screen.findByTestId('impact-cta')
    expect(screen.queryByText('Index this project')).toBeNull()
  })

  it('indexed HIGH-risk → risk chip, totals, and symbol chips with dependents counts', async () => {
    mockImpact.mockResolvedValue(HIGH)
    renderPanel()
    const panel = await screen.findByTestId('impact-panel')
    expect(screen.getByTestId('impact-risk').textContent).toBe('high risk')
    expect(panel.textContent).toContain('3 symbols · 16 dependents')
    expect(panel.textContent).toContain('saveRun · 12')
    expect(panel.textContent).toContain('listRuns · 4')
    expect(panel.textContent).toContain('fmtRow · 0')
    // symbol-less files are dropped from the body
    expect(panel.textContent).not.toContain('src/other.ts')
  })

  it('graph_update for the project refetches impact and unlocks a finished build', async () => {
    // graph/build is fire-and-forget (202) — completion arrives over the WS
    // graph_update channel. The panel must refetch its payload then and reset
    // the mutation so a failed build re-enables the CTA instead of locking on
    // "Indexing…" forever.
    mockImpact.mockResolvedValue(UNINDEXED)
    renderPanel()
    fireEvent.click(await screen.findByText('Index this project'))
    expect(await screen.findByText('Indexing…')).toBeTruthy()
    // Build finished but the payload is STILL unindexed (build failed):
    await act(async () => {
      for (const h of [...wsHandlers]) h({ type: 'graph_update', projectId: 'p1', meta: {} })
    })
    await waitFor(() => expect(mockImpact.mock.calls.length).toBeGreaterThanOrEqual(2))
    const btn = (await screen.findByText('Index this project')) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    // ...and a graph_update for a DIFFERENT project is ignored.
    const calls = mockImpact.mock.calls.length
    await act(async () => {
      for (const h of [...wsHandlers]) h({ type: 'graph_update', projectId: 'other', meta: {} })
    })
    expect(mockImpact.mock.calls.length).toBe(calls)
  })

  it('indexed with no files → renders nothing', async () => {
    mockImpact.mockResolvedValue({ ...HIGH, files: [], totalSymbols: 0, totalDependents: 0, risk: null })
    renderPanel()
    await waitFor(() => expect(mockImpact).toHaveBeenCalled())
    // flush the query resolution so the assertion sees the settled render
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(screen.queryByTestId('impact-panel')).toBeNull()
    expect(screen.queryByTestId('impact-cta')).toBeNull()
  })
})
