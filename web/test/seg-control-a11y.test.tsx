/**
 * SegControl aria-pressed (F-006): the segmented range control (Metrics + Routing)
 * must expose aria-pressed reflecting the current selection so screen readers can
 * tell which segment is active. Driven through RoutingPage (the lightest host —
 * its header SegControl renders before any data resolves). The query fns never
 * resolve so no chart mounts (jsdom has no canvas).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/api', () => ({
  api: {
    metrics: {
      routing: () => new Promise(() => {}),
      timeseries: () => new Promise(() => {}),
    },
  },
}))

import RoutingPage from '../src/pages/RoutingPage'

afterEach(() => cleanup())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RoutingPage />
    </QueryClientProvider>,
  )
}

describe('SegControl aria-pressed', () => {
  it('exposes aria-pressed reflecting the selected segment', () => {
    renderPage()
    // default range is 30d
    expect(screen.getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '14d' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '60d' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('aria-pressed follows a selection change', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '14d' }))
    expect(screen.getByRole('button', { name: '14d' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('false')
  })
})
