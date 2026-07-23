/**
 * HomePage (D-129 — Home = Overview only). The Chat|Overview SegControl is
 * gone (superseded — ChatView is retired from this route); HomePage renders
 * a single Overview surface under an in-page "Overview" section header
 * (SectionHeader, testid-free — same convention as other section labels).
 * The quick-ask affordance is the globally-mounted MessageDock bar variant
 * (Shell.tsx, not exercised here); a send from it redirects to Chats — see
 * message-dock.test.tsx's D-129 tests for that behavior. Stubs
 * homeLayout.get/put (OverviewView reads it via useHomeLayout) — `layout:
 * null` degrades to DEFAULT_LAYOUT, same as a fresh install that never saved
 * a custom grid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/api', () => ({
  api: {
    homeLayout: {
      get: vi.fn(async () => ({ layout: null })),
      put: vi.fn(async (layout) => ({ layout })),
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

import HomePage from '../src/pages/HomePage'

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
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('HomePage', () => {
  it('renders the Overview widget grid directly — no Chat|Overview SegControl', () => {
    renderHome()
    expect(screen.getByText('Overview')).toBeTruthy()
    expect(screen.getByTestId('overview-customize')).toBeTruthy()
    expect(screen.queryByTestId('seg-chat')).toBeNull()
    expect(screen.queryByTestId('seg-overview')).toBeNull()
  })
})
