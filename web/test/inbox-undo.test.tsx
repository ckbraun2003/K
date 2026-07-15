/** Inbox proposal dismiss — 5s undo window (mirrors MessageDock's dock-undo-toast).
 *  Dismiss hides the card and defers api.inbox.dismissProposal until the toast's
 *  timeout elapses; Undo cancels the deferred call and restores the card. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { InboxItem, InboxPayload } from '@k/shared'

const { mockList, mockApproveProposal, mockDismissProposal } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockApproveProposal: vi.fn(async () => {}),
  mockDismissProposal: vi.fn(async () => {}),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    inbox: {
      list: mockList,
      dismissReview: vi.fn(async () => {}),
      dismissMcp: vi.fn(async () => {}),
      approveProposal: mockApproveProposal,
      dismissProposal: mockDismissProposal,
    },
    memory: { approve: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) },
    capabilities: { trustMcp: vi.fn(async () => ({})) },
  },
}))

vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import InboxTab from '../src/pages/personal/InboxTab'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

beforeEach(() => {
  mockList.mockReset()
  mockApproveProposal.mockClear()
  mockDismissProposal.mockClear()
})
afterEach(() => cleanup())

function inboxWithProposal(): InboxPayload {
  const now = Date.now()
  const items: InboxItem[] = [
    { kind: 'proposal', id: 'proposal:wi1', ts: now, projectId: 'p1', projectName: 'Repo',
      title: 'CI is failing in Repo', workItemId: 'wi1', source: 'ci_failed', body: null },
  ]
  return {
    items,
    counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0, proposal: 1 },
    total: 1,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InboxTab />
    </QueryClientProvider>,
  )
}

describe('InboxTab — proposal dismiss undo window', () => {
  it('Dismiss hides the card immediately, defers the api call, and shows the undo toast', async () => {
    mockList.mockResolvedValue(inboxWithProposal())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-dismiss-proposal:wi1'))

    expect(screen.queryByTestId('inbox-card-proposal:wi1')).toBeNull()
    expect(mockDismissProposal).not.toHaveBeenCalled()
    expect(screen.getByTestId('inbox-undo-toast')).toBeTruthy()
    expect(screen.getByText(/CI is failing in Repo/)).toBeTruthy()
  })

  it('clicking Undo restores the card and never calls the api', async () => {
    mockList.mockResolvedValue(inboxWithProposal())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-dismiss-proposal:wi1'))
    expect(screen.queryByTestId('inbox-card-proposal:wi1')).toBeNull()

    fireEvent.click(screen.getByTestId('inbox-undo'))
    expect(await screen.findByTestId('inbox-card-proposal:wi1')).toBeTruthy()
    expect(mockDismissProposal).not.toHaveBeenCalled()
  })

  it('letting the toast time out commits the dismiss exactly once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockList.mockResolvedValue(inboxWithProposal())
      renderPage()
      fireEvent.click(await screen.findByTestId('inbox-dismiss-proposal:wi1'))
      await screen.findByTestId('inbox-undo-toast')
      expect(mockDismissProposal).not.toHaveBeenCalled()

      act(() => { vi.advanceTimersByTime(5000) })

      await waitFor(() => expect(mockDismissProposal).toHaveBeenCalledWith('wi1'))
      expect(mockDismissProposal).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
