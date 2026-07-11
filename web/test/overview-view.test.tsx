/**
 * OverviewView (UI Simplification Task 12) — the 3x3 widget grid framework:
 * renders a mocked stored layout, customize-mode add/remove round-trips
 * through `api.homeLayout.put` with a schema-valid `HomeLayout`, and a
 * throwing widget body is isolated by its per-cell WidgetErrorBoundary
 * without taking down its siblings. Mocks api at the same seam every other
 * page test uses (`../src/lib/api`) — no real network. The widgets registry
 * is partially mocked (real title-card stubs for everything except one
 * deliberately-throwing `org_glance`, via `importOriginal`) so the error-
 * boundary case doesn't need a second render path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { HomeLayout } from '@k/shared'
import { HomeLayoutSchema } from '@k/shared'
import { findSlot } from '../src/lib/home-layout'

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    homeLayout: {
      get: mockGet,
      put: mockPut,
    },
  },
}))

// Real title-card stubs for every widget except `org_glance`, which is swapped
// for a component that always throws — the ONE fixture the error-boundary
// test needs; every other test's layout never places org_glance, so they see
// the real (never-throwing) placeholder bodies.
vi.mock('../src/pages/home/widgets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pages/home/widgets')>()
  return {
    WIDGET_DEFS: {
      ...actual.WIDGET_DEFS,
      org_glance: {
        title: 'Org at a glance',
        component: () => {
          throw new Error('boom')
        },
      },
    },
  }
})

import OverviewView from '../src/pages/home/OverviewView'

// Deliberately NOT the full DEFAULT_LAYOUT: only 2 of 9 cells are placed, so
// there's room to exercise the empty-cell add picker and findSlot together.
const TEST_LAYOUT: HomeLayout = {
  widgets: [
    { id: 'active_runs', x: 0, y: 0, w: 2, h: 1 },
    { id: 'needs_you', x: 2, y: 0, w: 1, h: 1 },
  ],
}

const THROW_LAYOUT: HomeLayout = {
  widgets: [
    { id: 'org_glance', x: 0, y: 0, w: 1, h: 1 },
    { id: 'notes', x: 1, y: 0, w: 1, h: 1 },
  ],
}

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OverviewView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockGet.mockReset()
  mockPut.mockReset()
  mockGet.mockResolvedValue({ layout: TEST_LAYOUT })
  mockPut.mockImplementation(async (layout: HomeLayout) => ({ layout }))
})
afterEach(() => cleanup())

describe('OverviewView', () => {
  it('renders the grid from the mocked stored layout, one cell per placed widget', async () => {
    renderOverview()
    expect(await screen.findByText('Active runs')).toBeTruthy()
    expect(await screen.findByText('Needs you')).toBeTruthy()
    expect(screen.getByTestId('overview-customize')).toBeTruthy()
  })

  it('customize add places the new widget at findSlot and PUTs a schema-valid layout containing it', async () => {
    renderOverview()
    fireEvent.click(await screen.findByTestId('overview-customize'))

    const slot = findSlot(TEST_LAYOUT, 1, 1)
    expect(slot).toEqual({ x: 0, y: 1 })
    fireEvent.click(await screen.findByTestId(`overview-add-${slot!.x}-${slot!.y}`))
    fireEvent.click(await screen.findByTestId('overview-add-pick-cost_today'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1))
    const putLayout = mockPut.mock.calls[0][0] as HomeLayout
    expect(HomeLayoutSchema.safeParse(putLayout).success).toBe(true)
    expect(putLayout.widgets).toContainEqual({ id: 'cost_today', x: 0, y: 1, w: 1, h: 1 })
    expect(putLayout.widgets).toHaveLength(3)
  })

  it('customize remove PUTs a layout without the removed widget', async () => {
    renderOverview()
    fireEvent.click(await screen.findByTestId('overview-customize'))
    fireEvent.click(await screen.findByTestId('widget-remove-needs_you'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1))
    const putLayout = mockPut.mock.calls[0][0] as HomeLayout
    expect(HomeLayoutSchema.safeParse(putLayout).success).toBe(true)
    expect(putLayout.widgets.some(w => w.id === 'needs_you')).toBe(false)
    expect(putLayout.widgets).toHaveLength(1)
  })

  it('a widget whose component throws renders widget-error-<id> while its sibling stays intact', async () => {
    mockGet.mockResolvedValueOnce({ layout: THROW_LAYOUT })
    renderOverview()
    expect(await screen.findByTestId('widget-error-org_glance')).toBeTruthy()
    expect(await screen.findByText('Notes')).toBeTruthy()
  })
})
