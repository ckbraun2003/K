/**
 * KnowledgeGraphTab — auto-rotate rAF loop soft-crash fix (ui-adjustments Lane D).
 *
 * Root cause: the auto-rotate effect (~KnowledgeGraphTab.tsx line 239) used to omit
 * `mountGen` from its deps, unlike the sibling two-phase-mount effects. After a
 * GraphErrorBoundary remount the stale loop kept firing camera methods against a
 * torn-down/null graph instance, and since requestAnimationFrame callbacks run
 * OUTSIDE React's render/commit cycle, a throw there can never be caught by
 * GraphErrorBoundary — it escaped straight past the boundary and blanked the panel.
 *
 * This file drives requestAnimationFrame manually (captured, not auto-fired) so
 * frames can be stepped deterministically, and forces the mocked ForceGraph3D to
 * throw during render (the real WebGL-context-creation failure mode documented on
 * GraphErrorBoundary) to exercise a real boundary catch + Retry + remount cycle.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GraphResponse } from '@k/shared'

const { mockGraph, mockNavigate, cameraPositionSpy, cameraSpy, renderControl } = vi.hoisted(() => ({
  mockGraph: vi.fn(),
  mockNavigate: vi.fn(),
  cameraPositionSpy: vi.fn(),
  cameraSpy: vi.fn(),
  // Mutable flag the test flips to force the mocked ForceGraph3D to throw during
  // render — simulating the real "WebGL context creation fails on mount" crash
  // GraphErrorBoundary's docblock describes.
  renderControl: { shouldThrow: false },
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
    if (renderControl.shouldThrow) {
      throw new Error('simulated WebGL context creation failure')
    }
    React.useImperativeHandle(ref, () => ({
      zoomToFit: () => {},
      cameraPosition: cameraPositionSpy,
      camera: cameraSpy,
      d3Force: () => ({ distance: () => {}, strength: () => {} }),
    }))
    React.useEffect(() => {
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
  ],
  links: [],
  stale: false, status: 'ready', builtAt: Date.now(), nodeCount: 2, edgeCount: 0, error: null,
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeGraphTab projectId="p1" />
    </QueryClientProvider>,
  )
}

// Manual rAF harness — captures scheduled {id, callback} pairs (FIFO) instead of
// auto-firing, so a test can step exactly one frame at a time and assert precisely
// when the auto-rotate loop stops scheduling more of itself. cancelAnimationFrame
// actually removes the matching pending entry (mirroring real browser semantics) —
// without that, a cancelled frame would still appear "queued" and mask the fix.
let rafQueue: { id: number; cb: FrameRequestCallback }[]
let rafIdCounter: number
let cancelledIds: Set<number>

function stepFrame(ts = 16): void {
  const entry = rafQueue.shift()
  if (!entry) throw new Error('stepFrame: no frame was scheduled')
  entry.cb(ts)
}

beforeEach(() => {
  mockGraph.mockReset()
  mockGraph.mockResolvedValue(graph)
  mockNavigate.mockReset()
  cameraPositionSpy.mockClear()
  cameraSpy.mockReset()
  cameraSpy.mockReturnValue({ position: { x: 10, y: 0, z: 10 } })
  renderControl.shouldThrow = false

  rafQueue = []
  rafIdCounter = 0
  cancelledIds = new Set()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafIdCounter
    rafQueue.push({ id, cb })
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    cancelledIds.add(id)
    rafQueue = rafQueue.filter(e => e.id !== id)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('KnowledgeGraphTab — auto-rotate tick guards (soft-crash fix)', () => {
  it('bails without throwing when the graph ref is null (torn-down instance)', async () => {
    renderTab()
    await waitFor(() => expect(rafQueue.length).toBe(1)) // the loop's initial schedule
    // The 2-node graph triggers the unrelated DF-2 fit-on-load camera pin (small-fleet
    // clamp) via onEngineStop — clear it so only OUR tick-driven calls are asserted below.
    cameraPositionSpy.mockClear()

    // Prime lastTs on frame 1 (no-op frame), then simulate the instance having gone
    // away by the time frame 2 runs — cameraSpy itself absent is the same shape as
    // graphRef.current being null (both make `cam` falsy).
    stepFrame(0)
    cameraSpy.mockReturnValue(undefined)
    expect(() => stepFrame(16)).not.toThrow()

    // A benign bail still re-arms the next frame — the loop is alive, just idle.
    expect(rafQueue.length).toBe(1)
    expect(cameraPositionSpy).not.toHaveBeenCalled()
  })

  it('a throwing frame body cancels the loop instead of escaping or looping forever', async () => {
    renderTab()
    await waitFor(() => expect(rafQueue.length).toBe(1))

    stepFrame(0) // prime lastTs
    cameraPositionSpy.mockImplementation(() => {
      throw new Error('disposed WebGL context')
    })
    // The throw must be caught inside tick() — it must never propagate out of the
    // rAF callback (nothing downstream would catch it: rAF callbacks run outside
    // React's render/commit cycle, so GraphErrorBoundary cannot).
    expect(() => stepFrame(16)).not.toThrow()

    // The frame that had already been optimistically rescheduled at the top of
    // this tick() call must be cancelled — the loop does not keep re-arming itself
    // after a throw.
    expect(cancelledIds.size).toBe(1)
    expect(rafQueue.length).toBe(0)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('KnowledgeGraphTab — auto-rotate effect re-arms on a GraphErrorBoundary remount', () => {
  it('cancels the stale loop and starts a fresh one after Retry (mountGen bump)', async () => {
    renderTab()
    await waitFor(() => expect(rafQueue.length).toBe(1))
    const initialRafId = rafIdCounter // id of the loop's first scheduled frame

    // Force the mocked ForceGraph3D to throw on its NEXT render, then trigger a
    // re-render of that subtree (typing in the filter changes filteredData, which
    // flows into the graphData prop) — this is a real GraphErrorBoundary catch,
    // not a simulated one.
    renderControl.shouldThrow = true
    fireEvent.change(screen.getByPlaceholderText('Filter nodes…'), { target: { value: 'alpha' } })

    await waitFor(() => expect(screen.getByText('Graph failed to render.')).toBeTruthy())

    // The auto-rotate effect's deps (graph.nodes.length) haven't changed, so
    // without the mountGen fix this effect would never tear down or re-run — the
    // stale frame from before the crash is still the only one queued.
    expect(rafQueue.length).toBe(1)

    // Recover: stop throwing, click Retry — this calls handleGraphReset
    // (bumps mountGen), which the auto-rotate effect now depends on.
    renderControl.shouldThrow = false
    fireEvent.click(screen.getByText('Retry'))

    await waitFor(() => expect(screen.queryByText('Graph failed to render.')).toBeNull())
    await waitFor(() => expect(screen.getByTestId('force-graph-3d')).toBeTruthy())

    // The old (pre-remount) scheduled frame must have been cancelled by the
    // effect's cleanup, and a fresh frame scheduled by the effect re-running.
    await waitFor(() => expect(cancelledIds.has(initialRafId)).toBe(true))
    expect(rafQueue.length).toBe(1)
    expect(rafIdCounter).toBeGreaterThan(initialRafId)
  })
})
