/**
 * PrsCiTab — Wave 4 fixes:
 *   F-046: CI rows linkify to their GitHub Actions run URL; merged/closed PRs get
 *          their own section (previously open-only → zero links with 0 open PRs).
 *   F-047: the Create-PR modal defaults `base` to the repo's ACTUAL default branch
 *          (inferred from CI branches — 'master' here), not a hardcoded 'main'.
 *   F-061: a REMOTELESS project hides the Create-PR affordance entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GithubStatus, Project } from '@k/shared'
import { CiRunInfoSchema } from '@k/shared'
import { defaultBaseBranch, ciRunUrl, ciDuration } from '../src/pages/tabs/PrsCiTab'

describe('PrsCiTab helpers', () => {
  it('ciRunUrl composes the Actions URL when a remote is known, else null', () => {
    expect(ciRunUrl('owner/repo', 42)).toBe('https://github.com/owner/repo/actions/runs/42')
    expect(ciRunUrl(undefined, 42)).toBeNull()
  })
  // INT.2 FE IN-2: durationMs is an optional CiRunInfo field — round-trips through the
  // shared zod schema whether present (a completed run) or absent (still running).
  it('CiRunInfoSchema round-trips durationMs when present, and parses cleanly without it', () => {
    const withDuration = CiRunInfoSchema.parse({
      id: 1, workflow: 'CI', branch: 'main', status: 'completed', conclusion: 'success',
      createdAt: '2026-01-01T00:00:00Z', durationMs: 92_000,
    })
    expect(withDuration.durationMs).toBe(92_000)
    const noDuration = CiRunInfoSchema.parse({
      id: 2, workflow: 'CI', branch: 'main', status: 'in_progress', conclusion: null,
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(noDuration.durationMs).toBeUndefined()
  })
  it('ciDuration formats sub-minute durations in seconds, and longer ones as "Nm Ss"', () => {
    expect(ciDuration(42_000)).toBe('42s')
    expect(ciDuration(192_000)).toBe('3m 12s')
  })
  it('defaultBaseBranch prefers the PERSISTED project.defaultBranch over the CI heuristic (W4 follow-up)', () => {
    // Even when CI shows 'master', a persisted 'develop' wins — it's the exact truth.
    const gh = { prs: [], ci: [{ id: 1, workflow: 'ci', branch: 'master', status: 'completed', conclusion: 'success', createdAt: '' }], fetchedAt: 1 } as GithubStatus
    const project = { id: 'p1', name: 'P', localPath: '/p', workspaceManaged: false, bibleDir: 'docs/bible', defaultBranch: 'develop', createdAt: 0 } as Project
    expect(defaultBaseBranch(project, gh)).toBe('develop')
  })
  it('defaultBaseBranch falls back to the CI heuristic when no branch is persisted (master)', () => {
    const gh = { prs: [], ci: [{ id: 1, workflow: 'ci', branch: 'master', status: 'completed', conclusion: 'success', createdAt: '' }], fetchedAt: 1 } as GithubStatus
    const project = { id: 'p1', name: 'P', localPath: '/p', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 } as Project
    expect(defaultBaseBranch(project, gh)).toBe('master')
    expect(defaultBaseBranch(undefined, gh)).toBe('master')
  })
  it('defaultBaseBranch falls back to main when neither persisted nor a default-looking CI branch is present', () => {
    const gh = { prs: [], ci: [{ id: 1, workflow: 'ci', branch: 'feature/x', status: 'completed', conclusion: 'success', createdAt: '' }], fetchedAt: 1 } as GithubStatus
    expect(defaultBaseBranch(undefined, gh)).toBe('main')
    expect(defaultBaseBranch(undefined, undefined)).toBe('main')
  })
})

const { mockGithub, mockList, mockCreatePr } = vi.hoisted(() => ({
  mockGithub: vi.fn(),
  mockList: vi.fn(),
  mockCreatePr: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: { github: mockGithub, list: mockList, createPr: mockCreatePr },
  },
}))

import PrsCiTab from '../src/pages/tabs/PrsCiTab'

const githubStatus: GithubStatus = {
  prs: [
    { number: 1, title: 'open pr', state: 'OPEN', url: 'https://github.com/o/r/pull/1', checks: 'passing' },
    { number: 2, title: 'merged pr', state: 'MERGED', url: 'https://github.com/o/r/pull/2', checks: 'none' },
  ],
  ci: [
    { id: 555, workflow: 'CI', branch: 'master', status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', durationMs: 192_000 },
  ],
  fetchedAt: Date.now(),
}

const withRemote: Project = { id: 'p1', name: 'P', localPath: '/p', githubRemote: 'o/r', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 }
const noRemote: Project = { id: 'p1', name: 'P', localPath: '/p', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 }

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PrsCiTab projectId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockGithub.mockReset(); mockList.mockReset(); mockCreatePr.mockReset()
  mockGithub.mockResolvedValue(githubStatus)
})
afterEach(() => cleanup())

describe('PrsCiTab — F-046 links + merged PRs', () => {
  it('linkifies CI runs to their Actions URL and surfaces merged/closed PRs', async () => {
    mockList.mockResolvedValue([withRemote])
    renderTab()

    // CI run id is an external anchor to the Actions run URL.
    const ciLink = (await screen.findByLabelText('Open CI run 555 on GitHub')) as HTMLAnchorElement
    expect(ciLink.getAttribute('href')).toBe('https://github.com/o/r/actions/runs/555')

    // IN-2: a completed run with durationMs shows its duration alongside its age.
    expect((await screen.findByTestId('ci-row-duration')).textContent).toContain('3m 12s')

    // The merged PR now appears in its own section with its external anchor.
    expect(screen.getByText('merged pr')).toBeTruthy()
    expect(screen.getByText(/Merged \/ Closed/)).toBeTruthy()
    const prLinks = screen.getAllByLabelText('Open PR on GitHub') as HTMLAnchorElement[]
    expect(prLinks.some(a => a.getAttribute('href') === 'https://github.com/o/r/pull/2')).toBe(true)
  })
})

describe('PrsCiTab — F-047 default base branch', () => {
  it('pre-fills the PR base with the repo default branch inferred from CI (master)', async () => {
    mockList.mockResolvedValue([withRemote])
    renderTab()
    fireEvent.click(await screen.findByTestId('prs-open-pr'))
    const baseInput = (await screen.findByPlaceholderText('main')) as HTMLInputElement
    expect(baseInput.value).toBe('master')
  })
})

describe('PrsCiTab — F-061 remoteless', () => {
  it('hides the Create-PR affordance for a project with no remote', async () => {
    mockList.mockResolvedValue([noRemote])
    renderTab()
    await screen.findByTestId('prs-no-remote')
    expect(screen.queryByTestId('prs-open-pr')).toBeNull()
  })
})
