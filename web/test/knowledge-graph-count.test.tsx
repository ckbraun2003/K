/**
 * KnowledgeGraphTab — F-050: filtering narrowed the canvas but the "N nodes · M edges"
 * label kept showing the UNFILTERED totals. It must reflect the filtered counts.
 * react-force-graph-3d / ws are mocked (jsdom can't run WebGL / open a socket).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GraphResponse } from '@k/shared'

const { mockGraph, mockNavigate } = vi.hoisted(() => ({ mockGraph: vi.fn(), mockNavigate: vi.fn() }))

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    // @ts-expect-error minimal stub
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion / prefersReducedMotion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

vi.mock('react-force-graph-3d', async () => {
  const React = await import('react')
  const Comp = React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      zoomToFit: () => {}, cameraPosition: () => {}, d3Force: () => ({ distance: () => {}, strength: () => {} }),
    }))
    return React.createElement('div', { 'data-testid': 'force-graph-3d' })
  })
  return { default: Comp }
})

vi.mock('../src/lib/api', () => ({ api: { projects: { graph: mockGraph } } }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import KnowledgeGraphTab from '../src/pages/tabs/KnowledgeGraphTab'

const graph: GraphResponse = {
  nodes: [
    { id: 'alpha', label: 'alpha' },
    { id: 'beta', label: 'beta' },
    { id: 'gamma', label: 'gamma' },
  ],
  links: [{ source: 'alpha', target: 'beta' }],
  stale: false, status: 'ready', builtAt: Date.now(), nodeCount: 3, edgeCount: 1, error: null,
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeGraphTab projectId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => { mockGraph.mockReset(); mockGraph.mockResolvedValue(graph) })
afterEach(() => cleanup())

describe('KnowledgeGraphTab — F-050 count label', () => {
  it('the node/edge count label reflects the filtered graph', async () => {
    renderTab()
    // Wait for the graph query to resolve so the label reflects real data.
    await waitFor(() => expect(screen.getByTestId('kg-count-label').textContent).toBe('3 nodes · 1 edges'))

    fireEvent.change(screen.getByPlaceholderText('Filter nodes…'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByTestId('kg-count-label').textContent).toBe('1 nodes · 0 edges'))
  })
})
