/**
 * OverviewTab — F-053: the Overview tab lacked the remote/bible/CI status chips the
 * fleet cards show. They must render for parity: remote (from the project record),
 * bible (from the latest verification breakdown), CI (from the newest Actions run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project, VerificationReport, GithubStatus, Run } from '@k/shared'

const { mockVerifications, mockRunsList, mockGithub, mockList, mockNavigate } = vi.hoisted(() => ({
  mockVerifications: vi.fn(),
  mockRunsList: vi.fn(),
  mockGithub: vi.fn(),
  mockList: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: { verifications: mockVerifications, github: mockGithub, list: mockList, verify: vi.fn(), onboard: vi.fn() },
    runs: { list: mockRunsList },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import OverviewTab from '../src/pages/tabs/OverviewTab'

const reportWithBible: VerificationReport = {
  id: 'r1', projectId: 'p1', score: 88, findings: [], fixesApplied: [], startedAt: 1000,
  breakdown: { ci: 40, coverage: 20, bible: 20, findings: 8 },
}
const github: GithubStatus = {
  prs: [], fetchedAt: Date.now(),
  ci: [{ id: 1, workflow: 'CI', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '' }],
}
const project: Project = { id: 'p1', name: 'P', localPath: '/p', githubRemote: 'o/r', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 }

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OverviewTab projectId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockVerifications.mockReset(); mockRunsList.mockReset(); mockGithub.mockReset(); mockList.mockReset(); mockNavigate.mockClear()
  mockVerifications.mockResolvedValue([reportWithBible])
  mockRunsList.mockResolvedValue([] as Run[])
  mockGithub.mockResolvedValue(github)
  mockList.mockResolvedValue([project])
})
afterEach(() => cleanup())

describe('OverviewTab — F-053 parity chips', () => {
  it('renders remote, bible, and CI chips reflecting the project state', async () => {
    renderTab()
    // Wait for the project/verification/github queries to resolve into the chips.
    await screen.findByText('remote ✓ o/r')
    const chips = screen.getByTestId('overview-chips')
    expect(chips.textContent).toContain('remote ✓ o/r')
    expect(chips.textContent).toContain('bible ✓')
    expect(chips.textContent).toContain('CI ✓')
  })
})
