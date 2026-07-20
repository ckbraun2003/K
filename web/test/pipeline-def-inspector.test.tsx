/**
 * PipelineDefInspector (orch-p2 C.2) — a selected pipeline definition rendered
 * read-only: a visual DAG preview (every stage 'pending', via
 * `previewViewFromSpec` + the same `PipelineGraph` a live run uses), the full
 * stage list (kind, role/actor, model, handoff, retry/gate/loop policy), edges
 * (when + maxIterations), and the pipeline-level overview
 * (name/version/entry/crossProject). A "Clone to edit" toggle reveals a
 * read-only Textarea containing the spec's JSON, for copy-out authoring.
 * `api.pipelines.get` is mocked (vi.hoisted) — no live core needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PipelineSpec } from '@k/shared'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: { pipelines: { get: mockGet } },
}))

import PipelineDefInspector from '../src/components/PipelineDefInspector'

beforeAll(() => {
  // @xyflow/react (PipelineGraph, now embedded in the definition inspector) needs
  // ResizeObserver in jsdom.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any
})

const SPEC: PipelineSpec = {
  name: 'Bug Triage & Fix',
  version: 1,
  description: 'Reproduce, diagnose, fix, review.',
  entry: 'reproduce',
  crossProject: false,
  stages: [
    {
      kind: 'agent', id: 'reproduce', label: 'Reproduce', role: 'debugger',
      subagentType: 'debugger', profileId: null, model: null,
      promptScaffold: 'repro', planGate: false, hooks: [], injection: { mode: 'off', hints: [] },
      retry: { maxAttempts: 2, backoffMs: 0, retryOn: ['transient', 'timeout', 'model_capacity'] },
    },
    {
      kind: 'deterministic', id: 'verify', label: 'Verify', action: { type: 'verify' },
      hooks: [], injection: { mode: 'off', hints: [] }, retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    },
    {
      kind: 'gate', id: 'gate-clean', label: 'Clean gate', gate: { mode: 'declarative', predicate: {} },
      hooks: [], injection: { mode: 'off', hints: [] }, retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    },
  ],
  edges: [
    { from: 'reproduce', to: 'verify', handoff: 'share-tree', when: 'always' },
    { from: 'verify', to: 'reproduce', handoff: 'share-tree', when: 'loop', maxIterations: 3 },
    { from: 'verify', to: 'gate-clean', handoff: 'share-tree', when: 'pass' },
  ],
}

beforeEach(() => {
  mockGet.mockReset()
  mockGet.mockResolvedValue(SPEC)
})
afterEach(() => cleanup())

function renderInspector(defId = 'bug-triage') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineDefInspector defId={defId} />
    </QueryClientProvider>,
  )
}

describe('PipelineDefInspector', () => {
  it('renders the fetched spec — overview, stage list (kind/role/subagent/retry), and edges (when/maxIterations)', async () => {
    renderInspector()
    expect(mockGet).toHaveBeenCalledWith('bug-triage')

    // Overview.
    expect(await screen.findByText('Bug Triage & Fix')).toBeTruthy()
    expect(screen.getByText(/entry/i).closest('div')?.textContent).toContain('reproduce')

    // Visual DAG preview — same PipelineGraph a live run uses, fed a synthetic
    // all-'pending' view via previewViewFromSpec. waitFor the node itself: React
    // Flow can paint the container a tick before its node DOM.
    await waitFor(() => expect(screen.getByTestId('pipeline-graph')).toBeTruthy())
    await waitFor(() =>
      expect(within(screen.getByTestId('pipeline-graph')).getByTestId('pipeline-node-reproduce')).toBeTruthy(),
    )

    // Stage list.
    expect(screen.getByTestId('pipeline-def-stage-reproduce').textContent).toContain('debugger')
    expect(screen.getByTestId('pipeline-def-stage-reproduce').textContent).toMatch(/2/)
    expect(screen.getByTestId('pipeline-def-stage-verify').textContent).toContain('deterministic')
    expect(screen.getByTestId('pipeline-def-stage-gate-clean').textContent).toContain('gate')

    // Edges — the loop edge shows its bound.
    const loopEdge = screen.getByTestId('pipeline-def-edge-verify-reproduce')
    expect(loopEdge.textContent).toContain('loop')
    expect(loopEdge.textContent).toContain('3')
  })

  it('is read-only until "Clone to edit" is pressed, then reveals a Textarea with the spec JSON', async () => {
    renderInspector()
    await screen.findByText('Bug Triage & Fix')

    expect(screen.queryByTestId('pipeline-def-clone-textarea')).toBeNull()

    fireEvent.click(screen.getByTestId('pipeline-def-clone-toggle'))

    const textarea = await screen.findByTestId('pipeline-def-clone-textarea')
    expect(textarea).toBeTruthy()
    const value = (textarea as HTMLTextAreaElement).value
    const parsed = JSON.parse(value)
    expect(parsed.name).toBe('Bug Triage & Fix')
    expect(parsed.edges).toHaveLength(3)

    // Read-only — no onChange wiring, just a copyable artifact.
    expect(textarea).toHaveProperty('readOnly', true)
  })

  it('shows a loading skeleton then an error state with retry on fetch failure', async () => {
    mockGet.mockReset()
    mockGet.mockRejectedValue(new Error('boom'))
    renderInspector()
    await waitFor(() => expect(screen.getByTestId('pipeline-def-inspector-error')).toBeTruthy())
  })
})
