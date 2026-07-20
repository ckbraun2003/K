/**
 * HomePage (UI Simplification Task 11) — the Chat|Overview SegControl switch
 * (testids `seg-chat`/`seg-overview` free from SegControl.tsx). Chat is the
 * default landing tab (S-6: a fresh install with nothing stored faces K); the
 * picked tab persists to localStorage `'k.home.view'` so a reload restores it.
 * Mocks api at the same seam chat-view.test.tsx uses — ChatView is the
 * default-rendered tab, so it needs the same threads.list stub (no real
 * network, empty list keeps it to the "no crash" empty state). Also stubs
 * homeLayout.get/put (Task 12's OverviewView reads it via useHomeLayout) —
 * these tests only assert the SegControl switch/persistence, not grid
 * content, so a null (DEFAULT_LAYOUT-falling-back) layout is enough.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      list: vi.fn(async () => ({ threads: [] })),
      get: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    // ChatView marks the open conversation read (INT.2 read-cursor fix).
    conversations: { read: vi.fn(async () => ({ ok: true })) },
    // The Overview tab now renders the widget grid (Task 12) — it reads this
    // via useHomeLayout. `layout: null` degrades to DEFAULT_LAYOUT, same as
    // a fresh install that never saved a custom grid (spec 8.3).
    homeLayout: {
      get: vi.fn(async () => ({ layout: null })),
      put: vi.fn(async (layout) => ({ layout })),
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

import HomePage from '../src/pages/HomePage'
import { selectThread } from '../src/lib/thread-select'

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HomePage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  selectThread(null)
})
afterEach(() => {
  cleanup()
  selectThread(null)
  localStorage.clear()
})

describe('HomePage', () => {
  it('renders the Chat|Overview SegControl, defaulting to Chat on first boot (S-6)', () => {
    renderHome()
    expect(screen.getByTestId('seg-chat')).toBeTruthy()
    expect(screen.getByTestId('seg-overview')).toBeTruthy()
    expect(screen.getByTestId('seg-chat').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('seg-overview').getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking seg-overview swaps to the Overview widget grid and persists k.home.view', async () => {
    renderHome()
    fireEvent.click(screen.getByTestId('seg-overview'))
    await waitFor(() => expect(screen.getByTestId('seg-overview').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('overview-customize')).toBeTruthy()
    expect(localStorage.getItem('k.home.view')).toBe('overview')
  })

  it('re-mount restores the persisted view', async () => {
    const first = renderHome()
    fireEvent.click(screen.getByTestId('seg-overview'))
    await waitFor(() => expect(localStorage.getItem('k.home.view')).toBe('overview'))
    first.unmount()

    renderHome()
    await waitFor(() => expect(screen.getByTestId('seg-overview').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('overview-customize')).toBeTruthy()
  })
})
