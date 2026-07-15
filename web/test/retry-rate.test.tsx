import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { seriesSpy } = vi.hoisted(() => ({ seriesSpy: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { retryMetrics: { series: seriesSpy } } }))

import RetryRateChart from '../src/components/RetryRateChart'

function renderChart() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RetryRateChart days={14} />
    </QueryClientProvider>,
  )
}

// No jest-dom in this project — getBy* throws on miss, so .toBeTruthy() is the presence assertion.
afterEach(() => { cleanup(); seriesSpy.mockReset() })

describe('RetryRateChart', () => {
  it('renders the measured overall retry rate + per-day bars', async () => {
    seriesSpy.mockResolvedValue({ windowDays: 14, overallRate: 0.5, points: [{ day: '2026-07-11', runs: 2, retries: 1, rate: 0.5 }] })
    renderChart()
    await waitFor(() => expect(screen.getByText('50%')).toBeTruthy())
    expect(screen.getByTestId('retry-rate')).toBeTruthy()
    expect(screen.getByRole('img', { name: /retry rate per day/i })).toBeTruthy()
  })

  it('shows the empty state when there are no runs in the window', async () => {
    seriesSpy.mockResolvedValue({ windowDays: 14, overallRate: 0, points: [] })
    renderChart()
    // Task 7 (chart interaction layer): the empty-state copy is now shared with the
    // other hover-enabled charts' "No runs in window." wording, not retry-specific.
    await waitFor(() => expect(screen.getByText(/no runs in window/i)).toBeTruthy())
    expect(screen.getByText('0%')).toBeTruthy()
  })
})
