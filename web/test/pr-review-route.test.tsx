/** FE-5 — #/pr-review/<projectId>/<prNumber>: route plumbing, the full-screen
 *  PrReviewPage, and PrsCiTab's "Open review" link (accordion removed). */
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DiffPayload, GithubStatus, Project } from '@k/shared'
import { parseHash, isKnownView } from '../src/lib/route'
import diffPayload from './fixtures/impressive-wave/diff-payload.json'

const diff = diffPayload as DiffPayload

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => cleanup())

// ── Probe 1: pure route parsing (node env, no mocks needed) ────────────────
describe('pr-review route', () => {
  it('parses #/pr-review/<projectId>/<n> and is a known view', () => {
    expect(parseHash('#/pr-review/p1/7')).toEqual({ view: 'pr-review', param: 'p1', subParam: '7' })
    expect(isKnownView('pr-review')).toBe(true)
  })
})

const { mockPrDiff, mockGithub, mockList, mockNavigate } = vi.hoisted(() => ({
  mockPrDiff: vi.fn(), mockGithub: vi.fn(), mockList: vi.fn(), mockNavigate: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { projects: { prDiff: mockPrDiff, github: mockGithub, list: mockList, mergePr: vi.fn() } },
}))
vi.mock('../src/lib/route', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/route')>()
  return { ...actual, navigate: mockNavigate }
})

import PrReviewPage from '../src/pages/PrReviewPage'
import PrsCiTab from '../src/pages/tabs/PrsCiTab'

const GITHUB: GithubStatus = {
  prs: [{ number: 7, title: 'Add widget', state: 'OPEN', url: 'https://github.com/o/r/pull/7', checks: 'passing' }],
  ci: [],
  fetchedAt: 1,
}
const PROJECT: Project = { id: 'p1', name: 'Repo', localPath: 'C:\\repo', githubRemote: 'o/r' }

function withQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// ── Probe 2: PrReviewPage ───────────────────────────────────────────────────
describe('PrReviewPage', () => {
  beforeEach(() => {
    mockPrDiff.mockReset().mockResolvedValue(diff)
    mockGithub.mockReset().mockResolvedValue(GITHUB)
    mockList.mockReset().mockResolvedValue([PROJECT])
    mockNavigate.mockReset()
  })

  it('renders the full-screen page + ChangesLayout for a valid PR', async () => {
    withQuery(<PrReviewPage projectId="p1" prNumber="7" />)
    expect(await screen.findByTestId('pr-review-page')).toBeTruthy()
    expect(await screen.findByTestId('changes-layout')).toBeTruthy()
    expect(mockPrDiff).toHaveBeenCalledWith('p1', 7)
  })

  it('renders the PR-not-found EmptyState for a malformed prNumber', async () => {
    withQuery(<PrReviewPage projectId="p1" prNumber="not-a-number" />)
    expect(await screen.findByText('PR not found')).toBeTruthy()
    expect(mockPrDiff).not.toHaveBeenCalled()
  })
})

// ── Probe 3: PrsCiTab row action ────────────────────────────────────────────
describe('PrsCiTab "Open review"', () => {
  beforeEach(() => {
    mockPrDiff.mockReset()
    mockGithub.mockReset().mockResolvedValue(GITHUB)
    mockList.mockReset().mockResolvedValue([PROJECT])
    mockNavigate.mockReset()
  })

  it('links to #/pr-review/<projectId>/<n> and never fetches pr-diff on render', async () => {
    withQuery(<PrsCiTab projectId="p1" />)
    const btn = await screen.findByTestId('pr-open-review-7')
    btn.click()
    expect(mockNavigate).toHaveBeenCalledWith('pr-review', 'p1', '7')
    expect(mockPrDiff).not.toHaveBeenCalled()
  })
})
