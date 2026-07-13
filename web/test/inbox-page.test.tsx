import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { InboxItem, InboxItemKind, InboxPayload } from '@k/shared'

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    inbox: {
      list: mockList,
      dismissReview: vi.fn(async () => {}),
      dismissMcp: vi.fn(async () => {}),
    },
    memory: { approve: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) },
    capabilities: { trustMcp: vi.fn(async () => ({})) },
  },
}))

vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import { api } from '../src/lib/api'
import { navigate } from '../src/lib/route'
import InboxTab from '../src/pages/personal/InboxTab'
import { EMPTY_INBOX } from '../src/lib/inbox-query'

// jsdom has no matchMedia; framer-motion (via Toast) may probe it. Inert stub.
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
})
afterEach(() => cleanup())

// ── Factory: one item of each kind + matching counts ─────────────────────────
function fullInbox(): InboxPayload {
  const now = Date.now()
  const items: InboxItem[] = [
    { kind: 'plan_pending', id: 'plan_pending:r1', ts: now - 1000, projectId: 'p1', projectName: 'Repo',
      title: 'Plan for feature X', runId: 'r1', risk: 'low', steps: 3, edited: false },
    { kind: 'input_needed', id: 'input_needed:r2', ts: now - 2000, projectId: 'p1', projectName: 'Repo',
      title: 'Run waiting on your reply', runId: 'r2', model: 'claude-opus-4-8' },
    { kind: 'review_ready', id: 'review_ready:r3', ts: now - 3000, projectId: 'p1', projectName: 'Repo',
      title: 'Ready for review', runId: 'r3', verifyStatus: 'pass' },
    { kind: 'lesson_pending', id: 'lesson_pending:les1', ts: now - 4000, projectId: null, projectName: null,
      title: 'Always run typecheck before committing.', lessonId: 'les1', profileName: 'K' },
    { kind: 'mcp_trust', id: 'mcp_trust:user:foo', ts: now - 5000, projectId: null, projectName: null,
      title: 'Trust MCP server foo', qualifiedKey: 'user:foo', sourceKind: 'claude-user', command: 'npx foo' },
  ]
  return {
    items,
    counts: { plan_pending: 1, input_needed: 1, lesson_pending: 1, mcp_trust: 1, review_ready: 1, proposal: 0 },
    total: 5,
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

describe('InboxTab', () => {
  it('renders a section container for each of the five kinds', async () => {
    mockList.mockResolvedValue(fullInbox())
    renderPage()
    for (const kind of ['plan_pending', 'input_needed', 'review_ready', 'lesson_pending', 'mcp_trust'] as InboxItemKind[]) {
      expect(await screen.findByTestId(`inbox-section-${kind}`)).toBeTruthy()
    }
  })

  it('approving a lesson card calls api.memory.approve with the lessonId', async () => {
    mockList.mockResolvedValue(fullInbox())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-approve-lesson_pending:les1'))
    await waitFor(() => expect(api.memory.approve).toHaveBeenCalledWith('les1'))
  })

  it('dismissing an mcp card calls api.inbox.dismissMcp with the RAW qualifiedKey', async () => {
    mockList.mockResolvedValue(fullInbox())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-dismiss-mcp_trust:user:foo'))
    await waitFor(() => expect(api.inbox.dismissMcp).toHaveBeenCalledWith('user:foo'))
  })

  it('dismissing a review card calls api.inbox.dismissReview with the runId', async () => {
    mockList.mockResolvedValue(fullInbox())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-dismiss-review_ready:r3'))
    await waitFor(() => expect(api.inbox.dismissReview).toHaveBeenCalledWith('r3'))
  })

  it('renders the exact zero state when the inbox is empty', async () => {
    mockList.mockResolvedValue(EMPTY_INBOX)
    renderPage()
    expect(await screen.findByText('Inbox zero — nothing needs you.')).toBeTruthy()
    // The section containers must NOT render when their counts are 0.
    expect(screen.queryByTestId('inbox-section-plan_pending')).toBeNull()
  })

  // Bonus: navigate is used for the run-console handoff kinds.
  it('opening a review navigates to the run console', async () => {
    mockList.mockResolvedValue(fullInbox())
    renderPage()
    fireEvent.click(await screen.findByTestId('inbox-open-review_ready:r3'))
    expect(navigate).toHaveBeenCalledWith('runs', 'r3')
  })
})
