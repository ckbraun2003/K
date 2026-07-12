/**
 * RosterView — K + Chief cards (UI Simplification Task 16 spec §7). Two
 * non-orchestrator cards are prepended ahead of the orchestrator grid: K (the
 * front-door secretary — chat lives on Home) and Chief (the manager — see the
 * Tree view). The orchestrator grid + OrchestratorCard health line are locked by
 * roster-view-card.test.tsx and org-page.test.tsx; this file covers only the two
 * new cards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OrchestratorRosterPayload } from '@k/shared'

const { mockList, mockNavigate } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({ api: { orchestrators: { list: mockList } } }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import RosterView from '../src/pages/org/RosterView'

const empty: OrchestratorRosterPayload = { leads: [], activeLeads: 0 }

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RosterView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockList.mockReset()
  mockNavigate.mockClear()
  mockList.mockResolvedValue(empty)
})
afterEach(() => cleanup())

describe('RosterView — K + Chief cards', () => {
  it('renders both cards', () => {
    renderView()
    expect(screen.getByTestId('roster-card-k')).toBeTruthy()
    expect(screen.getByTestId('roster-card-chief')).toBeTruthy()
  })

  it('the K card navigates home', () => {
    renderView()
    fireEvent.click(screen.getByTestId('roster-card-k'))
    expect(mockNavigate).toHaveBeenCalledWith('home')
  })

  it('the Chief card navigates to the org tree segment', () => {
    renderView()
    fireEvent.click(screen.getByTestId('roster-card-chief'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'org', 'tree')
  })
})
