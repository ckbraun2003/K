import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { it, expect, vi, afterEach } from 'vitest'

// Hoisted api mock (the repo idiom, not vi.spyOn) so the chart's useQuery reads a
// deterministic measured burn-down.
const { burndownSpy } = vi.hoisted(() => ({ burndownSpy: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { budget: { burndown: burndownSpy } } }))
import BudgetBurndownChart from '../src/components/BudgetBurndownChart'

afterEach(() => cleanup())

function mockBuckets() {
  burndownSpy.mockResolvedValue({
    windowDays: 14, groupBy: 'day', totalCostUsd: 3,
    buckets: [
      { key: '2026-07-10', label: '2026-07-10', costUsd: 1, runs: 2 },
      { key: '2026-07-11', label: '2026-07-11', costUsd: 2, runs: 3 },
    ],
  })
}

it('renders measured daily bars + a labeled total (Task 7: no more floating totals)', async () => {
  mockBuckets()
  const qc = new QueryClient()
  render(<QueryClientProvider client={qc}><BudgetBurndownChart /></QueryClientProvider>)
  // Repo idiom (no jest-dom): getBy* throws when absent, so its success is the assertion.
  await waitFor(() => expect(screen.getByTestId('budget-burndown').textContent).toContain('$3.00'))
  expect(screen.getByText('$3.00')).toBeTruthy()
  expect(screen.getByText('measured spend · 14d')).toBeTruthy()
})

it('hovering column 0 renders the glass tooltip (label · cost · runs)', async () => {
  mockBuckets()
  const qc = new QueryClient()
  const { container } = render(<QueryClientProvider client={qc}><BudgetBurndownChart /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByTestId('budget-burndown').textContent).toContain('$3.00'))
  // SVG children in document order: 3 gridlines, then N bar rects, then N hover-overlay
  // rects — column 0's overlay is the (N)th rect (index === bucket count).
  const rects = container.querySelectorAll('svg rect')
  fireEvent.mouseEnter(rects[2])
  expect(screen.getByText('2026-07-10')).toBeTruthy()
  expect(screen.getByText('$1.00 (2 runs)')).toBeTruthy()
})
