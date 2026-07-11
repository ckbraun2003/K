/**
 * HomePage (UI Simplification Task 11) — the Chat|Overview SegControl switch
 * (testids `seg-chat`/`seg-overview` free from SegControl.tsx). Chat is the
 * default landing tab (S-6: a fresh install with nothing stored faces K); the
 * picked tab persists to localStorage `'k.home.view'` so a reload restores it.
 * Mocks api at the same seam chat-view.test.tsx uses — ChatView is the
 * default-rendered tab, so it needs the same threads.list stub (no real
 * network, empty list keeps it to the "no crash" empty state).
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

  it('clicking seg-overview swaps to the Overview stub and persists k.home.view', async () => {
    renderHome()
    fireEvent.click(screen.getByTestId('seg-overview'))
    await waitFor(() => expect(screen.getByTestId('seg-overview').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('home-overview-stub')).toBeTruthy()
    expect(localStorage.getItem('k.home.view')).toBe('overview')
  })

  it('re-mount restores the persisted view', async () => {
    const first = renderHome()
    fireEvent.click(screen.getByTestId('seg-overview'))
    await waitFor(() => expect(localStorage.getItem('k.home.view')).toBe('overview'))
    first.unmount()

    renderHome()
    await waitFor(() => expect(screen.getByTestId('seg-overview').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('home-overview-stub')).toBeTruthy()
  })
})
