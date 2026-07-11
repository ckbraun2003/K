/** P4 A1 — Insights 4-tab shell: defaults overview, deep-links the tab param, hides the shared
 *  window on Evals. Tab bodies are mocked so this targets the shell. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
vi.mock('../src/pages/insights/OverviewTab', () => ({ default: () => <div data-testid="body-overview" /> }))
vi.mock('../src/pages/insights/ChartsTab', () => ({ default: () => <div data-testid="body-charts" /> }))
vi.mock('../src/pages/insights/RoutingTab', () => ({ default: () => <div data-testid="body-routing" /> }))
vi.mock('../src/pages/insights/EvalsTab', () => ({ default: () => <div data-testid="body-evals" /> }))
import InsightsPage from '../src/pages/InsightsPage'
afterEach(() => cleanup())

describe('InsightsPage', () => {
  it('defaults to Overview and marks its tab selected', () => {
    render(<InsightsPage />)
    expect(screen.getByTestId('body-overview')).toBeTruthy()
    expect(screen.getByTestId('tab-overview').getAttribute('aria-selected')).toBe('true')
  })
  it('deep-links the charts tab', () => {
    render(<InsightsPage tab="charts" />)
    expect(screen.getByTestId('body-charts')).toBeTruthy()
  })
  it('shows the shared window control except on Evals', () => {
    const { rerender } = render(<InsightsPage tab="charts" />)
    expect(screen.getByTestId('seg-14')).toBeTruthy()
    rerender(<InsightsPage tab="evals" />)
    expect(screen.queryByTestId('seg-14')).toBeNull()
  })
})
