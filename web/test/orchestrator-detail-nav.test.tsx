/** P4 B2 — OrchestratorDetailPage nav remaps: back -> org/roster (loaded + NotFound),
 *  Memory link -> lessons. Authority tab row is the canonical SegControl (seg-* testids).
 *
 *  Task 17 (UI Simplification) additions: the Runs tab (recentRuns render + row
 *  navigation + empty state), the Memory tab's pending|accepted|rejected SegControl
 *  (status re-query + approve/reject wired only on pending), and the header's
 *  measured recent-cost line (exact string + omitted when n===0). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChiefOrgLead, AgentProfile, RecentActuals } from '@k/shared'
import type { MemoryLesson } from '../src/lib/memory'

const { mockGet, mockLessons, mockNavigate, mockRecentActuals, mockApprove, mockReject } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockLessons: vi.fn(),
  mockNavigate: vi.fn(),
  mockRecentActuals: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    orchestrators: { get: mockGet, update: vi.fn() },
    memory: { lessons: mockLessons, approve: mockApprove, reject: mockReject },
    orgDefault: { get: vi.fn() },
    metrics: { recentActuals: mockRecentActuals },
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

const NO_ACTUALS: RecentActuals = { scope: 'none', n: 0, windowDays: 30, medianCostUsd: null, p90CostUsd: null }

function lesson(over: Partial<MemoryLesson> = {}): MemoryLesson {
  return {
    id: 'les-1', runId: 'run-abcdef123456', profileId: 'lead-web', profileName: 'Web Lead',
    lesson: 'Always run typecheck before committing.', status: 'pending',
    createdAt: Date.now() - 60_000, reviewedAt: null, ...over,
  }
}

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
  mockRecentActuals.mockReset(); mockApprove.mockReset(); mockReject.mockReset()
  mockLessons.mockResolvedValue([])
  mockRecentActuals.mockResolvedValue(NO_ACTUALS)
  mockApprove.mockResolvedValue({})
  mockReject.mockResolvedValue({})
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

  it('Memory tab "Inbox" link navigates to personal/inbox', async () => {
    mockGet.mockResolvedValue(detail)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-memory'))
    fireEvent.click(await screen.findByTestId('orchestrator-memory-link'))
    expect(mockNavigate).toHaveBeenCalledWith('personal', 'inbox')
  })
})

// ── Task 17 — Runs tab ──────────────────────────────────────────────────────

describe('OrchestratorDetailPage — Runs tab', () => {
  it('renders this lead\'s recentRuns and navigates on row click', async () => {
    const withRuns = {
      ...detail,
      recentRuns: [
        { id: 'run-aaaaaaaa1111', status: 'done', createdAt: Date.now() - 60_000, costUsd: 0.0271 },
        { id: 'run-bbbbbbbb2222', status: 'error', createdAt: Date.now() - 120_000, costUsd: 0.0042 },
      ],
    } as unknown as ChiefOrgLead
    mockGet.mockResolvedValue(withRuns)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-runs'))

    const row = await screen.findByTestId('orchestrator-run-run-aaaaaaaa1111')
    expect(row.textContent).toContain('done')
    expect(row.textContent).toContain('0.0271')
    fireEvent.click(row)
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-aaaaaaaa1111')

    const failedRow = screen.getByTestId('orchestrator-run-run-bbbbbbbb2222')
    expect(failedRow.textContent).toContain('error')
  })

  it('shows an empty state when the lead has no recentRuns', async () => {
    mockGet.mockResolvedValue({ ...detail, recentRuns: [] } as unknown as ChiefOrgLead)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-runs'))
    expect(await screen.findByTestId('orchestrator-runs-empty')).toBeTruthy()
  })
})

// ── Task 17 — Memory tab status SegControl + pending-only actions ──────────

describe('OrchestratorDetailPage — Memory tab status SegControl', () => {
  beforeEach(() => {
    mockGet.mockResolvedValue(detail)
  })

  it('defaults to pending and re-queries the server on status change', async () => {
    mockLessons.mockResolvedValue([lesson()])
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-memory'))

    await waitFor(() =>
      expect(mockLessons).toHaveBeenCalledWith({ profileId: 'lead-web', status: 'pending' }),
    )
    await screen.findByTestId('memory-lesson-les-1')

    mockLessons.mockResolvedValue([lesson({ id: 'les-2', status: 'accepted', reviewedAt: Date.now() })])
    fireEvent.click(screen.getByTestId('seg-accepted'))
    await waitFor(() =>
      expect(mockLessons).toHaveBeenCalledWith({ profileId: 'lead-web', status: 'accepted' }),
    )
    await screen.findByTestId('memory-lesson-les-2')
  })

  it('wires approve/reject only when viewing pending; accepted/rejected are read-only', async () => {
    mockLessons.mockResolvedValue([lesson()])
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-memory'))
    await screen.findByTestId('memory-lesson-les-1')

    expect(screen.getByTestId('memory-approve-les-1')).toBeTruthy()
    expect(screen.getByTestId('memory-reject-les-1')).toBeTruthy()

    fireEvent.click(screen.getByTestId('memory-approve-les-1'))
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('les-1'))

    mockLessons.mockResolvedValue([lesson({ id: 'les-3', status: 'rejected', reviewedAt: Date.now() })])
    fireEvent.click(screen.getByTestId('seg-rejected'))
    await screen.findByTestId('memory-lesson-les-3')
    expect(screen.queryByTestId('memory-approve-les-3')).toBeNull()
    expect(screen.queryByTestId('memory-reject-les-3')).toBeNull()
  })

  it('shows a status-scoped empty state', async () => {
    mockLessons.mockResolvedValue([])
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    fireEvent.click(screen.getByTestId('seg-memory'))
    const empty = await screen.findByTestId('orchestrator-memory-empty')
    expect(empty.textContent).toContain('pending')
  })
})

// ── Task 17 — header measured recent-cost line ───────────────────────────────

describe('OrchestratorDetailPage — header recent-cost line', () => {
  it('renders the exact measured-actuals string when n > 0', async () => {
    mockGet.mockResolvedValue(detail)
    mockRecentActuals.mockResolvedValue({
      scope: 'profile', n: 6, windowDays: 30, medianCostUsd: 0.0268, p90CostUsd: 0.0272,
    } as RecentActuals)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    const el = await screen.findByTestId('orch-recent-cost')
    expect(el.textContent).toBe('recent: median $0.0268 · p90 $0.0272 (n=6, 30d)')
    // Measured actuals only — never a price/rate-derived phrase.
    expect(el.textContent).not.toMatch(/per token|estimate|rate/i)
  })

  it('is omitted (not rendered as a zeroed line) when n === 0', async () => {
    mockGet.mockResolvedValue(detail)
    mockRecentActuals.mockResolvedValue(NO_ACTUALS)
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    // Give the recentActuals query a tick to settle before asserting absence.
    await waitFor(() => expect(mockRecentActuals).toHaveBeenCalled())
    expect(screen.queryByTestId('orch-recent-cost')).toBeNull()
  })

  it('renders a distinct honest error indicator when the fetch fails (never silently omitted)', async () => {
    mockGet.mockResolvedValue(detail)
    mockRecentActuals.mockRejectedValue(new Error('metrics unavailable'))
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    // Fetch failure must be distinguishable from the legitimate n===0 omission
    // (D-026 honesty; CostTodayWidget's isError branch is the precedent).
    const err = await screen.findByTestId('orch-recent-cost-error')
    expect(err.textContent).toBe('cost data unavailable')
    expect(screen.queryByTestId('orch-recent-cost')).toBeNull()
    expect(document.body.textContent).not.toContain('recent: median')
  })
})
