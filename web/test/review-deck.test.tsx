/** P1 A3 — ReviewDeck: header chips, action gating, confirm→mutation→toast. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DiffPayload, ReviewComment } from '@k/shared'

const { mockDiff, mockComments, mockCreate, mockDelete, mockRequest, mockApprove } = vi.hoisted(() => ({
  mockDiff: vi.fn(),
  mockComments: vi.fn(),
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  mockRequest: vi.fn(),
  mockApprove: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: {
      diff: mockDiff,
      comments: mockComments,
      createComment: mockCreate,
      deleteComment: mockDelete,
      requestChanges: mockRequest,
      approve: mockApprove,
    },
  },
}))
// VerifyChip (Lane B) and ImpactPanel (Lane C) are mounted blind — mock to inert.
vi.mock('../src/components/VerifyChip', () => ({ default: () => null }))
vi.mock('../src/components/ImpactPanel', () => ({ default: () => null }))

import ReviewDeck from '../src/components/ReviewDeck'

const DIFF: DiffPayload = {
  source: 'checkpoint',
  baseRef: 'base',
  headRef: 'head',
  truncated: false,
  files: [
    {
      path: 'src/a.ts', oldPath: null, status: 'modified', binary: false, additions: 3, deletions: 2,
      hunks: [{
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { kind: 'del', text: 'x', oldLine: 1, newLine: null },
          { kind: 'add', text: 'y', oldLine: null, newLine: 1 },
        ],
      }],
    },
  ],
}

const draft: ReviewComment = {
  id: 'c1', runId: 'r1', file: 'src/a.ts', line: 1, side: 'new', body: 'fix', status: 'draft', createdAt: 0,
}

function renderDeck() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReviewDeck runId="r1" projectId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockDiff.mockReset(); mockComments.mockReset(); mockCreate.mockReset()
  mockDelete.mockReset(); mockRequest.mockReset(); mockApprove.mockReset()
  mockDiff.mockResolvedValue(DIFF)
  mockComments.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('ReviewDeck', () => {
  it('renders the metric chip (N files · +A −D)', async () => {
    renderDeck()
    // Wait for the diff query to resolve (the loading render shows "0 files ·").
    const chip = await screen.findByText(/1 files ·/)
    // Header totals from the single file: +3 −2 (split across tone spans).
    expect(chip.textContent).toContain('+3')
    expect(chip.textContent).toContain('−2')
  })

  it('disables Request changes when there are 0 draft comments', async () => {
    renderDeck()
    const btn = (await screen.findByTestId('deck-request-changes')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('(0)')
  })

  it('approve: opens the confirm dialog, fires the mutation, and shows a toast', async () => {
    mockApprove.mockResolvedValue({ branch: 'k-review/r1', pr: { number: 7, url: 'u', title: 't', state: 'open' } })
    renderDeck()
    const approveBtn = (await screen.findByTestId('deck-approve')) as HTMLButtonElement
    // Enabled only once the diff (files > 0) has loaded.
    await waitFor(() => expect(approveBtn.disabled).toBe(false))
    fireEvent.click(approveBtn)
    // Confirm dialog appears.
    await screen.findByTestId('deck-approve-dialog')
    fireEvent.click(screen.getByTestId('deck-approve-dialog-confirm'))
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('r1'))
    expect(await screen.findByTestId('deck-toast')).toBeTruthy()
    expect(screen.getByText(/PR #7 opened from k-review\/r1/)).toBeTruthy()
  })

  it('request-changes: enabled with a draft, confirm fires the mutation and toasts with a View run action', async () => {
    mockComments.mockResolvedValue([draft])
    mockRequest.mockResolvedValue({ run: { id: 'fix1' }, commentsSent: 1 })
    renderDeck()
    const btn = (await screen.findByTestId('deck-request-changes')) as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await screen.findByTestId('deck-request-dialog')
    fireEvent.click(screen.getByTestId('deck-request-dialog-confirm'))
    await waitFor(() => expect(mockRequest).toHaveBeenCalled())
    expect(await screen.findByTestId('deck-toast')).toBeTruthy()
    expect(screen.getByText(/Fix run dispatched \(1 comment\)/)).toBeTruthy()
    expect(screen.getByText('View run')).toBeTruthy()
  })
})
