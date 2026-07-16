import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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

describe('InboxTab — proposal cards', () => {
  it('renders the "Proposals to approve" section with a source chip', async () => {
    mockList.mockResolvedValue(inboxWithProposal())
    renderPage()
    expect(await screen.findByTestId('inbox-section-proposal')).toBeTruthy()
    expect(await screen.findByTestId('inbox-card-proposal:wi1')).toBeTruthy()
    expect(screen.getByText('CI')).toBeTruthy() // ci_failed → "CI" chip
  })

  it('clicking Approve calls api.inbox.approveProposal with the workItemId', async () => {
    mockList.mockResolvedValue(inboxWithProposal())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-approve-proposal:wi1'))
    await waitFor(() => expect(mockApproveProposal).toHaveBeenCalledWith('wi1'))
  })

  it('clicking Dismiss hides the card immediately (the api call is deferred to the undo window — see inbox-undo.test.tsx)', async () => {
    mockList.mockResolvedValue(inboxWithProposal())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-dismiss-proposal:wi1'))
    expect(screen.queryByTestId('inbox-card-proposal:wi1')).toBeNull()
    expect(mockDismissProposal).not.toHaveBeenCalled()
  })
})
