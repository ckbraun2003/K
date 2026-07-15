/** P4 A1 — Insights 4-tab shell: defaults charts (impressive-wave Q2), deep-links the tab param,
 *  hides the shared window on Evals. Tab bodies are mocked so this targets the shell. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
vi.mock('../src/pages/insights/OverviewTab', () => ({ default: () => <div data-testid="body-overview" /> }))
vi.mock('../src/pages/insights/ChartsTab', () => ({ default: () => <div data-testid="body-charts" /> }))
vi.mock('../src/pages/insights/RoutingTab', () => ({ default: () => <div data-testid="body-routing" /> }))
vi.mock('../src/pages/insights/EvalsTab', () => ({ default: () => <div data-testid="body-evals" /> }))
import InsightsPage from '../src/pages/InsightsPage'
afterEach(() => cleanup())

describe('InsightsPage', () => {
  it('defaults to Charts and marks its tab selected (impressive-wave Q2)', () => {
    render(<InsightsPage />)
    expect(screen.getByTestId('body-charts')).toBeTruthy()
    expect(screen.getByTestId('tab-charts').getAttribute('aria-selected')).toBe('true')
  })
  it('deep-links the overview tab (#/insights/overview stays reachable)', () => {
    render(<InsightsPage tab="overview" />)
    expect(screen.getByTestId('body-overview')).toBeTruthy()
  })
  it('shows the shared window control except on Evals', () => {
    const { rerender } = render(<InsightsPage tab="charts" />)
    expect(screen.getByTestId('seg-14')).toBeTruthy()
    rerender(<InsightsPage tab="evals" />)
    expect(screen.queryByTestId('seg-14')).toBeNull()
  })
})
