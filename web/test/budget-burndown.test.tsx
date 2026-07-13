import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { it, expect, vi } from 'vitest'

// Hoisted api mock (the repo idiom, not vi.spyOn) so the chart's useQuery reads a
// deterministic measured burn-down.
const { burndownSpy } = vi.hoisted(() => ({ burndownSpy: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { budget: { burndown: burndownSpy } } }))
import BudgetBurndownChart from '../src/components/BudgetBurndownChart'

it('renders measured daily bars + total label', async () => {
  burndownSpy.mockResolvedValue({
    windowDays: 14, groupBy: 'day', totalCostUsd: 3,
    buckets: [
      { key: '2026-07-10', label: '2026-07-10', costUsd: 1, runs: 2 },
      { key: '2026-07-11', label: '2026-07-11', costUsd: 2, runs: 3 },
    ],
  })
  const qc = new QueryClient()
  render(<QueryClientProvider client={qc}><BudgetBurndownChart /></QueryClientProvider>)
  // Repo idiom (no jest-dom): getBy* throws when absent, so its success is the assertion.
  await waitFor(() => expect(screen.getByTestId('budget-burndown').textContent).toContain('$3.00'))
  expect(screen.getByText('$3.00')).toBeTruthy()
})
