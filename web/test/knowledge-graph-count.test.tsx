/**
 * KnowledgeGraphTab — F-050: filtering narrowed the canvas but the "N nodes · M edges"
 * label kept showing the UNFILTERED totals. It must reflect the filtered counts.
 * react-force-graph-3d / ws are mocked (jsdom can't run WebGL / open a socket).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GraphResponse } from '@k/shared'
import { EMPTY_FORCE_GRAPH_DATA } from '../src/lib/graph'

const { mockGraph, mockNavigate, zoomToFitSpy, cameraPositionSpy, graphDataSpy, propsSpy } = vi.hoisted(() => ({
  mockGraph: vi.fn(),
  mockNavigate: vi.fn(),
  zoomToFitSpy: vi.fn(),
  cameraPositionSpy: vi.fn(),
  graphDataSpy: vi.fn(),
  propsSpy: vi.fn(),
}))

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
  const Comp = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      zoomToFit: zoomToFitSpy,
      cameraPosition: cameraPositionSpy,
      d3Force: () => ({ distance: () => {}, strength: () => {} }),
    }))
    // Mirrors graph-view.test.tsx's mock: the real component calls onEngineStop
    // after EVERY graphData digest, and the D1 two-phase mount means that fires
    // once for the empty phase-1 shape and again once real data swaps in — so the
    // dep array tracks graphData, not `[]`, to simulate both digests.
    React.useEffect(() => {
      graphDataSpy(props.graphData)
      propsSpy(props)
      ;(props.onEngineStop as (() => void) | undefined)?.()
    }, [props.graphData])
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

beforeEach(() => {
  mockGraph.mockReset()
  mockGraph.mockResolvedValue(graph)
  zoomToFitSpy.mockClear()
  cameraPositionSpy.mockClear()
  graphDataSpy.mockClear()
  propsSpy.mockClear()
})
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

describe('KnowledgeGraphTab — D1 two-phase mount (ui-adjustments)', () => {
  it('feeds the empty sentinel to ForceGraph3D before the real graph data', async () => {
    renderTab()
    // The count label reflects filteredData regardless of forcesReady, so it can
    // resolve on the FIRST (phase-1) digest alone. Wait on the fit-on-load path
    // instead — it only fires once forcesReady flips true on the phase-2 (real
    // data) digest, so by the time it resolves both captures are guaranteed in.
    await waitFor(() => expect(zoomToFitSpy).toHaveBeenCalled())

    const captured = graphDataSpy.mock.calls.map(c => c[0])
    expect(captured.length).toBeGreaterThanOrEqual(2)
    // Phase 1: the very first graphData this mock ever saw is the sentinel itself
    // (referential identity), not just an empty-shaped object.
    expect(captured[0]).toBe(EMPTY_FORCE_GRAPH_DATA)
    // Phase 2: a later value swaps in the real nodes.
    expect(
      captured.some(d => Array.isArray((d as { nodes?: unknown[] })?.nodes) && (d as { nodes: unknown[] }).nodes.length === graph.nodes.length),
    ).toBe(true)
  })
})

describe('KnowledgeGraphTab — fit-on-load', () => {
  it('auto-fits once the layout settles on first load, then never again (didFitRef)', async () => {
    renderTab()
    await waitFor(() => expect(zoomToFitSpy).toHaveBeenCalled())
    const callsAfterFirstFit = zoomToFitSpy.mock.calls.length
    expect(callsAfterFirstFit).toBeGreaterThan(0)

    // A later re-digest (e.g. the filter narrowing filteredData) must NOT re-fit —
    // the one-shot latch (didFitRef) guards onEngineStop past the first real digest.
    fireEvent.change(screen.getByPlaceholderText('Filter nodes…'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByTestId('kg-count-label').textContent).toBe('1 nodes · 0 edges'))
    expect(zoomToFitSpy.mock.calls.length).toBe(callsAfterFirstFit)
  })
})

describe('KnowledgeGraphTab — D-134 off-main-thread fixed-position mount', () => {
  it('mounts with warmupTicks=0 / cooldownTicks=0 (zero main-thread simulation)', async () => {
    renderTab()
    // Wait for the phase-2 (real, positioned) mount — fit-on-load only fires then.
    await waitFor(() => expect(zoomToFitSpy).toHaveBeenCalled())
    // EVERY ForceGraph3D render used a zero warmup: the old synchronous headless
    // warmup (the freeze cause) is gone — positions are precomputed off-thread.
    expect(propsSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [props] of propsSpy.mock.calls) {
      expect(props.warmupTicks).toBe(0)
      expect(props.cooldownTicks).toBe(0)
    }
  })

  it('pins the real nodes at precomputed fixed fx/fy/fz positions', async () => {
    renderTab()
    await waitFor(() => expect(zoomToFitSpy).toHaveBeenCalled())
    const captured = graphDataSpy.mock.calls.map(c => c[0]) as Array<{ nodes?: Array<Record<string, unknown>> }>
    const realData = captured.find(d => Array.isArray(d?.nodes) && d.nodes!.length === graph.nodes.length)
    expect(realData).toBeTruthy()
    for (const n of realData!.nodes!) {
      expect(Number.isFinite(n.fx as number)).toBe(true)
      expect(Number.isFinite(n.fy as number)).toBe(true)
      expect(Number.isFinite(n.fz as number)).toBe(true)
    }
  })

  it('shows the "Computing layout…" overlay only until positions arrive', async () => {
    renderTab()
    // The synchronous fallback (jsdom has no Worker) resolves positions on mount, so
    // once the real graph is up the overlay is gone. (The overlay markup is exercised
    // here; the transient computing state is covered by the pure-fn + fallback path.)
    await waitFor(() => expect(screen.getByTestId('force-graph-3d')).toBeTruthy())
    await waitFor(() => expect(screen.queryByTestId('kg-layout-overlay')).toBeNull())
  })
})
