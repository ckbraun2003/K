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

const { fitSpy, cameraPositionSpy, mockList, mockNavigate } = vi.hoisted(() => ({
  fitSpy: vi.fn(),
  cameraPositionSpy: vi.fn(),
  mockList: vi.fn(),
  mockNavigate: vi.fn(),
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
    // Simulate the layout settling — the real component calls onEngineStop then.
    React.useEffect(() => {
      ;(props.onEngineStop as (() => void) | undefined)?.()
    }, [])
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

beforeEach(() => { fitSpy.mockClear(); cameraPositionSpy.mockClear(); mockList.mockReset(); mockList.mockResolvedValue(projects) })
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
