/**
 * FE-4 systemic #3 (Row adoption) — render probes for the pieces that don't
 * already have dedicated coverage of the specific behavior Task 5 added:
 *   1. RunList surfaces a run's wall-clock duration (data-testid="run-duration")
 *      once it has ended — the runDuration() helper wired through <Row>'s meta slot.
 *   2. CiRow's branch chip (the Tag Row's meta slot now carries).
 *   3. RecentActivityWidget groups feed rows by local calendar day, "Today" first.
 *
 * ONE shared vi.mock per module path (api/ws/route) — see Task 4's lesson: calling
 * vi.mock for the same path more than once in a file collides (hoisting is
 * per-module-path, not per-describe-block), so every SUT's needed namespace is
 * folded into a single top-level factory.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { Run, GithubStatus, Project, FeedPayload } from '@k/shared'

const { mockRunsList, mockGithub, mockProjectsList, mockFeedList } = vi.hoisted(() => ({
  mockRunsList: vi.fn(),
  mockGithub: vi.fn(),
  mockProjectsList: vi.fn(),
  mockFeedList: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: { list: mockRunsList, kill: vi.fn() },
    projects: { github: mockGithub, list: mockProjectsList, createPr: vi.fn() },
    feed: { list: mockFeedList },
  },
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import RunList from '../src/components/RunList'
import PrsCiTab from '../src/pages/tabs/PrsCiTab'
import RecentActivityWidget from '../src/pages/home/widgets/RecentActivityWidget'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion's AnimatePresence probes
    window.matchMedia = (q: string) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })
  }
})
afterEach(() => {
  cleanup()
  mockRunsList.mockReset()
  mockGithub.mockReset()
  mockProjectsList.mockReset()
  mockFeedList.mockReset()
})

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('RunList Row adoption — duration', () => {
  it('renders run-duration for a finished run', async () => {
    const run: Run = {
      id: 'r1', prompt: 'a run', cwd: '/repo', status: 'done', provider: 'claude', model: 'm',
      tokensIn: 0, tokensOut: 0, costUsd: 0.01, createdAt: 0, endedAt: 65_000,
    }
    mockRunsList.mockResolvedValue([run])
    renderWithQuery(<RunList selectedId={null} onSelect={() => {}} />)
    expect((await screen.findByTestId('run-duration')).textContent).toBe('1m 5s')
  })

  it('an OPEN run (no endedAt) never renders run-duration', async () => {
    const run: Run = {
      id: 'r2', prompt: 'still going', cwd: '/repo', status: 'running', provider: 'claude', model: 'm',
      tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0,
    }
    mockRunsList.mockResolvedValue([run])
    renderWithQuery(<RunList selectedId={null} onSelect={() => {}} />)
    await screen.findByTestId('run-row')
    expect(screen.queryByTestId('run-duration')).toBeNull()
  })
})

describe('PrsCiTab CiRow Row adoption — branch chip', () => {
  const project: Project = {
    id: 'p1', name: 'P', localPath: '/p', githubRemote: 'o/r', workspaceManaged: false,
    bibleDir: 'docs/bible', createdAt: 0,
  }
  const githubStatus: GithubStatus = {
    prs: [],
    ci: [{ id: 1, workflow: 'CI', branch: 'feat/thing', status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z' }],
    fetchedAt: Date.now(),
  }

  it("renders the run's branch as a chip", async () => {
    mockProjectsList.mockResolvedValue([project])
    mockGithub.mockResolvedValue(githubStatus)
    renderWithQuery(<PrsCiTab projectId="p1" />)
    expect(await screen.findByText('feat/thing')).toBeTruthy()
  })
})

describe('RecentActivityWidget Row adoption — day grouping', () => {
  it('renders a "Today" group header before an older date header', async () => {
    const now = Date.now()
    const payload: FeedPayload = {
      items: [
        { id: 'a', kind: 'done', ts: now, runId: 'r1', runStatus: 'done', projectId: null, projectName: null, title: 'today item', detail: null },
        { id: 'b', kind: 'done', ts: now - 5 * 24 * 3600_000, runId: 'r2', runStatus: 'done', projectId: null, projectName: null, title: 'older item', detail: null },
      ],
      counts: { dispatch: 0, park: 0, plan_gate: 0, review_ready: 0, pr: 0, merge: 0, verify_pass: 0, verify_fail: 0, failure: 0, done: 2 },
      total: 2,
    }
    mockFeedList.mockResolvedValue(payload)
    renderWithQuery(<RecentActivityWidget />)
    const headers = await screen.findAllByTestId('feed-day-header')
    expect(headers.length).toBe(2)
    expect(headers[0].textContent).toBe('Today')
    expect(headers[1].textContent).not.toBe('Today')
  })
})
