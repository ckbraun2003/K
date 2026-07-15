/** P1 W0d — RunConsole gains a third `changes` view mounting the ReviewDeck stub. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockGet, mockEvents, mockStatus, mockProjects } = vi.hoisted(() => ({
  mockGet: vi.fn(), mockEvents: vi.fn(), mockStatus: vi.fn(), mockProjects: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    runs: {
      get: mockGet, events: mockEvents,
      kill: vi.fn(), sendInput: vi.fn(), end: vi.fn(), eventRaw: vi.fn().mockResolvedValue(''),
      diff: vi.fn().mockResolvedValue({ source: 'checkpoint', baseRef: null, headRef: null, files: [], truncated: false }),
      comments: vi.fn().mockResolvedValue([]), verifyResult: vi.fn().mockRejectedValue(new Error('404')),
      impact: vi.fn().mockResolvedValue({ indexed: false, projectId: null, files: [], totalSymbols: 0, totalDependents: 0, risk: null }),
    },
    projects: { list: mockProjects },
    status: mockStatus,
  },
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
import RunConsole from '../src/components/RunConsole'

const RUN = {
  id: '11111111-2222-4333-8444-555555555555', prompt: 'do a thing', cwd: 'C:\\repo',
  status: 'done', provider: 'claude', model: 'claude-haiku-4-5-20251001',
  tokensIn: 1, tokensOut: 1, costUsd: 0, createdAt: 1, endedAt: 2,
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView (RunConsole's auto-scroll calls it on mount).
  Element.prototype.scrollIntoView = vi.fn()
  mockGet.mockResolvedValue(RUN)
  mockEvents.mockResolvedValue([])
  mockStatus.mockResolvedValue({})
  mockProjects.mockResolvedValue([])
})
afterEach(() => cleanup())

function renderConsole() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunConsole runId={RUN.id} />
    </QueryClientProvider>,
  )
}

describe('RunConsole review view', () => {
  it('offers console | timeline | changes and mounts the deck', async () => {
    renderConsole()
    const btn = await screen.findByRole('button', { name: 'changes' })
    fireEvent.click(btn)
    expect(await screen.findByTestId('review-deck')).toBeTruthy()
  })
})
