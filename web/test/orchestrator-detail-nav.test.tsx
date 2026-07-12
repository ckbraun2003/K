/** P4 B2 — OrchestratorDetailPage nav remaps: back -> org/roster (loaded + NotFound),
 *  Memory link -> lessons. Authority tab row is the canonical SegControl (seg-* testids). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChiefOrgLead, AgentProfile } from '@k/shared'

const { mockGet, mockLessons, mockNavigate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockLessons: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    orchestrators: { get: mockGet, update: vi.fn() },
    memory: { lessons: mockLessons },
    orgDefault: { get: vi.fn() },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import OrchestratorDetailPage from '../src/pages/OrchestratorDetailPage'

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'lead-web', name: 'Web Lead', tier: 'orchestrator', charter: 'orchestrator',
    defaultModel: null, allowedTools: [], mcpServers: [], skills: [], ...over,
  }
}
const detail = {
  profile: profile(), latestRun: null, events: [], wakes: [],
  recent: null, effectiveModel: null,
} as unknown as ChiefOrgLead

function renderPage(id?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OrchestratorDetailPage id={id} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockGet.mockReset(); mockLessons.mockReset(); mockNavigate.mockClear()
  mockLessons.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('OrchestratorDetailPage — nav remaps (P4 B2)', () => {
  it('NotFound back button navigates to org/roster (unknown id -> isError)', async () => {
    mockGet.mockRejectedValue(new Error('404'))
    renderPage('ghost')
    await screen.findByTestId('orchestrator-notfound')
    fireEvent.click(screen.getByRole('button', { name: /Orchestrators/ }))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'org', 'roster')
  })

  it('loaded-page header back button navigates to org/roster', async () => {
    mockGet.mockResolvedValue(detail)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByRole('button', { name: /Orchestrators/ }))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'org', 'roster')
  })

  it('Memory tab "Memory page" link navigates to lessons', async () => {
    mockGet.mockResolvedValue(detail)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-memory'))
    fireEvent.click(await screen.findByTestId('orchestrator-memory-link'))
    expect(mockNavigate).toHaveBeenCalledWith('lessons')
  })
})
