/** P4 A2 — the Overview tab renders DETERMINISTIC deltas + anomaly callouts from the WINDOWED
 *  endpoints (timeseries + quality), FILTERS null quality points (no NaN), and the shared window
 *  cross-filters (a 30d switch re-queries timeseries + quality with 30 — NOT summary()). */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MetricsTimeseries, MetricsQualityTimeseries } from '@k/shared'

const { timeseriesSpy, qualitySpy, routingSpy } = vi.hoisted(() => ({
  timeseriesSpy: vi.fn(),
  qualitySpy: vi.fn(),
  routingSpy: vi.fn(),
}))
// Overview MUST source the windowed endpoints — assert the cross-filter never falls back to summary().
const summarySpy = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/api', () => ({
  api: { metrics: { timeseries: timeseriesSpy, quality: qualitySpy, routing: routingSpy, summary: summarySpy } },
}))
// The sibling tabs are inert here so InsightsPage mounts only the REAL OverviewTab.
vi.mock('../src/pages/insights/ChartsTab', () => ({ default: () => <div data-testid="body-charts" /> }))
vi.mock('../src/pages/insights/RoutingTab', () => ({ default: () => <div data-testid="body-routing" /> }))
vi.mock('../src/pages/insights/EvalsTab', () => ({ default: () => <div data-testid="body-evals" /> }))

import OverviewTab from '../src/pages/insights/OverviewTab'
import InsightsPage from '../src/pages/InsightsPage'

// Rising-cost window over 6 days: cost [1,1,1,5,5,5] (earlier sum 3 -> later sum 15 = +400%, bad).
function makeTimeseries(): MetricsTimeseries {
  const cost = [1, 1, 1, 5, 5, 5]
  return {
    groupBy: 'project',
    days: 14,
    dates: ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'],
    series: [
      {
        key: 'p1',
        label: 'P1',
        points: cost.map(c => ({ runs: 10, tokens: 0, costUsd: c })),
        total: { runs: 60, tokens: 0, costUsd: 18 },
      },
    ],
  }
}
// A quality window with a latency SPIKE on the last day AND a fully-null day (terminalRuns 0) to
// prove the null-filter: lat filtered = [100,100,100,100,800], z(800) = 2.0 -> a warn anomaly.
function makeQuality(): MetricsQualityTimeseries {
  const points = [
    { date: 'd0', terminalRuns: 5, successRate: 0.95, avgLatencyMs: 100, latencyCount: 5 },
    { date: 'd1', terminalRuns: 5, successRate: 0.96, avgLatencyMs: 100, latencyCount: 5 },
    { date: 'd2', terminalRuns: 0, successRate: null, avgLatencyMs: null, latencyCount: 0 }, // null day
    { date: 'd3', terminalRuns: 5, successRate: 0.95, avgLatencyMs: 100, latencyCount: 5 },
    { date: 'd4', terminalRuns: 5, successRate: 0.94, avgLatencyMs: 100, latencyCount: 5 },
    { date: 'd5', terminalRuns: 5, successRate: 0.9, avgLatencyMs: 800, latencyCount: 5 }, // spike
  ]
  return { days: 14, dates: points.map(p => p.date), points }
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
  timeseriesSpy.mockReset().mockResolvedValue(makeTimeseries())
  qualitySpy.mockReset().mockResolvedValue(makeQuality())
  routingSpy.mockReset().mockResolvedValue({ groups: [], recommendation: '', latencyP50Ms: 0, latencyP95Ms: 0 })
  summarySpy.mockReset().mockResolvedValue({})
})
afterEach(() => cleanup())

describe('OverviewTab (deterministic deltas + anomalies)', () => {
  it('renders a toned delta tile and an anomaly callout from the windowed endpoints — no NaN from null points', async () => {
    render(
      <QueryClientProvider client={client()}>
        <OverviewTab days={14} />
      </QueryClientProvider>,
    )
    // measured cost delta: current $15.00, +400% (cost up = bad tone)
    const costTile = await screen.findByTestId('delta-cost')
    expect(costTile.textContent).toContain('$15.00')
    expect(costTile.textContent).toContain('400%')
    // the latency spike is flagged (null quality day was filtered, not NaN-propagated)
    const anomaly = await screen.findByTestId('anomaly-latency')
    expect(anomaly.textContent).toMatch(/sigma above/)
    // NO NaN leaks anywhere in the rendered Overview
    expect(screen.getByTestId('insights-overview').textContent).not.toContain('NaN')
    // Overview sources the WINDOWED endpoints, never the fixed-14d summary()
    expect(timeseriesSpy).toHaveBeenCalledWith(14, 'project')
    expect(qualitySpy).toHaveBeenCalledWith(14)
    expect(summarySpy).not.toHaveBeenCalled()
  })
})

describe('Insights shared-window cross-filter (E-10)', () => {
  it('switching the window to 30d re-queries timeseries + quality with 30 (not summary)', async () => {
    render(
      <QueryClientProvider client={client()}>
        <InsightsPage tab="overview" />
      </QueryClientProvider>,
    )
    // initial window is 14d
    await waitFor(() => expect(timeseriesSpy).toHaveBeenCalledWith(14, 'project'))
    await waitFor(() => expect(qualitySpy).toHaveBeenCalledWith(14))

    // flip the shared window to 30d
    fireEvent.click(screen.getByTestId('seg-30'))

    await waitFor(() => expect(timeseriesSpy).toHaveBeenCalledWith(30, 'project'))
    await waitFor(() => expect(qualitySpy).toHaveBeenCalledWith(30))
    // the cross-filter must NOT rely on the un-windowed summary()
    expect(summarySpy).not.toHaveBeenCalled()
  })
})
