/**
 * FleetGraphPage — F-043: the fleet graph had neither auto-fit nor a Fit control, so
 * with a few widely-spaced project nodes only one landed in-viewport. We assert a Fit
 * affordance exists AND that auto-fit is invoked when the force layout settles
 * (onEngineStop). jsdom can't measure WebGL layout, so react-force-graph-3d is mocked
 * with a stub that exposes zoomToFit + fires onEngineStop on mount.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@k/shared'
import { EMPTY_FORCE_GRAPH_DATA } from '../src/lib/graph'

const { fitSpy, cameraPositionSpy, mockList, mockNavigate, graphDataSpy } = vi.hoisted(() => ({
  fitSpy: vi.fn(),
  cameraPositionSpy: vi.fn(),
  mockList: vi.fn(),
  mockNavigate: vi.fn(),
  graphDataSpy: vi.fn(),
}))

beforeAll(() => {
  // jsdom lacks ResizeObserver (the page observes its container to size the canvas).
  if (!globalThis.ResizeObserver) {
    // @ts-expect-error minimal stub
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
})

vi.mock('react-force-graph-3d', async () => {
  const React = await import('react')
  const Comp = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      zoomToFit: fitSpy,
      cameraPosition: cameraPositionSpy,
      d3Force: () => ({ distance: () => {}, strength: () => {} }),
    }))
    // Simulate the layout settling — the real component calls onEngineStop after
    // EVERY graphData digest, not just once on mount. ui-adjustments D1 feeds an
    // empty shape first (forces get tuned), then swaps in the real data — that
    // second digest is what actually fires the auto-fit, so the dep array must
    // track graphData (not `[]`) to simulate that second digest firing too.
    React.useEffect(() => {
      // Records EVERY graphData value this mock receives, in order — used by the
      // D1 two-phase-mount test below to assert the empty sentinel goes first.
      graphDataSpy(props.graphData)
      ;(props.onEngineStop as (() => void) | undefined)?.()
    }, [props.graphData])
    return React.createElement('div', { 'data-testid': 'force-graph-3d' })
  })
  return { default: Comp }
})

vi.mock('../src/lib/api', () => ({ api: { projects: { list: mockList } } }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import FleetGraphPage from '../src/pages/org/GraphView'

const projects: Project[] = [
  { id: 'a', name: 'A', localPath: '/a', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 },
  { id: 'b', name: 'B', localPath: '/b', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 },
  { id: 'c', name: 'C', localPath: '/c', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 },
]

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FleetGraphPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fitSpy.mockClear()
  cameraPositionSpy.mockClear()
  graphDataSpy.mockClear()
  mockList.mockReset()
  mockList.mockResolvedValue(projects)
})
afterEach(() => cleanup())

describe('FleetGraphPage — F-043 fit', () => {
  it('auto-fits when the layout settles and exposes a Fit control', async () => {
    renderPage()
    // Fit affordance exists.
    const fitBtn = await screen.findByTestId('fleet-graph-fit')
    expect(fitBtn).toBeTruthy()
    // Auto-fit fired on engine-stop (graph ready).
    await waitFor(() => expect(fitSpy).toHaveBeenCalled())

    const autoCalls = fitSpy.mock.calls.length
    fireEvent.click(fitBtn)
    expect(fitSpy.mock.calls.length).toBe(autoCalls + 1)
  })
})

describe('FleetGraphPage — D1 two-phase mount (ui-adjustments)', () => {
  it('feeds the empty sentinel to ForceGraph3D before the real project data', async () => {
    renderPage()
    await waitFor(() => expect(fitSpy).toHaveBeenCalled())

    const captured = graphDataSpy.mock.calls.map(c => c[0])
    expect(captured.length).toBeGreaterThanOrEqual(2)
    // Phase 1: the very first graphData this mock ever saw is the sentinel itself
    // (referential identity), not just an empty-shaped object.
    expect(captured[0]).toBe(EMPTY_FORCE_GRAPH_DATA)
    // Phase 2: a later value swaps in the real project nodes.
    expect(
      captured.some(d => Array.isArray((d as { nodes?: unknown[] })?.nodes) && (d as { nodes: unknown[] }).nodes.length === projects.length),
    ).toBe(true)
  })
})

describe('FleetGraphPage — DF-2 small-fleet camera clamp', () => {
  it('pins the camera (not zoomToFit) when the fleet has only 1 project', async () => {
    mockList.mockResolvedValue([projects[0]])
    renderPage()
    const fitBtn = await screen.findByTestId('fleet-graph-fit')
    await waitFor(() => expect(cameraPositionSpy).toHaveBeenCalled())
    expect(fitSpy).not.toHaveBeenCalled()

    const autoCalls = cameraPositionSpy.mock.calls.length
    fireEvent.click(fitBtn)
    expect(cameraPositionSpy.mock.calls.length).toBe(autoCalls + 1)
    expect(fitSpy).not.toHaveBeenCalled()
  })
})
