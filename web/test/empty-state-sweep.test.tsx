/**
 * Empty-state sweep (impressive-wave FE-4 systemic #2): representative probes
 * across the one-voice empty-state pass — one per distinct mechanism, not an
 * exhaustive re-test of every page (each page's own test file covers render
 * correctness; this file is the cross-cutting contract check):
 *   1. ChatView's K-intro suggestion chip prefills + focuses the dock.
 *   2. InboxTab's zero state uses the illustration slot, not a doubled icon bubble.
 *   3. ReviewDeck hides Approve/Request-changes entirely at 0 files (never a
 *      disabled-button "three treatments on one screen").
 *
 * All three SUTs' network seams are mocked in ONE file-level `api` mock (vi.mock
 * is hoisted per-module — a second `vi.mock('../src/lib/api', ...)` for the same
 * path in this file would silently collide) — mirrors the shape each source
 * page's own dedicated test file (chat-view/inbox-page/review-deck) mocks.
 */
import type { ReactElement } from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import type { KThreadSummary, DiffPayload } from '@k/shared'

const {
  mockThreadsList, mockThreadsGet, mockInboxList, mockDiff, mockComments, mockPrefillDock,
} = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockThreadsGet: vi.fn(),
  mockInboxList: vi.fn(),
  mockDiff: vi.fn(),
  mockComments: vi.fn(),
  mockPrefillDock: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: { list: mockThreadsList, get: mockThreadsGet, update: vi.fn(), create: vi.fn(), remove: vi.fn() },
    inbox: { list: mockInboxList, dismissReview: vi.fn(), dismissMcp: vi.fn() },
    memory: { approve: vi.fn(), reject: vi.fn() },
    capabilities: { trustMcp: vi.fn() },
    runs: {
      diff: mockDiff,
      comments: mockComments,
      createComment: vi.fn(),
      deleteComment: vi.fn(),
      requestChanges: vi.fn(),
      approve: vi.fn(),
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/dock-bus', () => ({ prefillDock: mockPrefillDock }))
vi.mock('../src/components/VerifyChip', () => ({ default: () => null }))
vi.mock('../src/components/ImpactPanel', () => ({ default: () => null }))

import ChatView from '../src/pages/home/ChatView'
import { selectThread } from '../src/lib/thread-select'
import InboxTab from '../src/pages/personal/InboxTab'
import { EMPTY_INBOX } from '../src/lib/inbox-query'
import ReviewDeck from '../src/components/ReviewDeck'

// jsdom stubs the two SUTs need (scrollIntoView for ChatView's transcript,
// matchMedia for InboxTab's Toast/framer-motion).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

afterEach(() => {
  cleanup()
  selectThread(null)
})

function renderWithQuery(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function thread(over: Partial<KThreadSummary>): KThreadSummary {
  return {
    id: 'kt-1', title: 'Untitled', status: 'idle', activeRunId: null, archivedAt: null,
    createdAt: 0, updatedAt: 0, snippet: null, lastTurnAt: null, ...over,
  }
}

describe('empty-state sweep: ChatView suggestion chips', () => {
  it('renders the K-intro suggestion chips and clicking one calls prefillDock', async () => {
    mockThreadsList.mockReset(); mockThreadsGet.mockReset(); mockPrefillDock.mockReset()
    mockThreadsList.mockResolvedValue({ threads: [] })
    mockThreadsGet.mockResolvedValue({ thread: thread({}), turns: [] })
    selectThread(null)

    renderWithQuery(<ChatView />)

    const chips = await screen.findAllByTestId('chat-suggest')
    expect(chips.length).toBeGreaterThan(0)
    fireEvent.click(chips[0])
    expect(mockPrefillDock).toHaveBeenCalledWith('What needs my attention today?')
  })
})

describe('empty-state sweep: InboxTab all-caught-up', () => {
  it('renders the "All caught up" illustration EmptyState with no doubled icon bubble', async () => {
    mockInboxList.mockReset()
    mockInboxList.mockResolvedValue(EMPTY_INBOX)

    const { container } = renderWithQuery(<InboxTab />)

    const zero = await screen.findByTestId('inbox-zero')
    expect(zero.textContent).toContain('All caught up')
    // The illustration slot replaces the icon bubble entirely — never both.
    expect(zero.querySelectorAll('.glass-panel, .surface-solid').length).toBe(0)
    expect(container.querySelector('[aria-hidden]')).toBeTruthy()
  })
})

describe('empty-state sweep: ReviewDeck zero-diff', () => {
  it('hides Approve / Request-changes entirely at 0 files and shows the EmptyState', async () => {
    const emptyDiff: DiffPayload = {
      source: 'checkpoint', baseRef: 'base', headRef: 'head', truncated: false, files: [],
    }
    mockDiff.mockReset(); mockComments.mockReset()
    mockDiff.mockResolvedValue(emptyDiff)
    mockComments.mockResolvedValue([])

    renderWithQuery(<ReviewDeck runId="r1" projectId="p1" />)

    await waitFor(() => expect(screen.getByText('No checkpointed changes')).toBeTruthy())
    expect(screen.queryByTestId('deck-approve')).toBeNull()
    expect(screen.queryByTestId('deck-request-changes')).toBeNull()
  })
})
