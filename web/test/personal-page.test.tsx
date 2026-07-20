/**
 * PersonalPage — UI Simplification Task 14. The 3-tab hub shell (Inbox/Tasks/
 * Memories; the former Chats tab folded into the Messages surface — Continuous
 * Agents B.6, redirect covered in route.test.ts/route-redirects.test.ts).
 * Gate assertions:
 *   - the tab bar renders all 3 tabs (and no Chats tab)
 *   - the `tab` prop selects the matching tab (an unknown value falls back to inbox)
 *   - clicking a tab navigates to personal/<tab>
 *   - the inbox tab's TabItem.count mirrors the shared INBOX_KEY query's total
 *   - the default tab (no `tab` prop) is inbox, and it renders the real InboxTab
 * api + route.navigate are mocked (vi.hoisted, mirroring khome.test.tsx). Every
 * sub-tab's api surface is mocked so any of the 3 tabs can mount without crashing,
 * regardless of which one is active in a given test.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { InboxPayload } from '@k/shared'

// jsdom has no matchMedia; framer-motion (via InboxTab's Toast) may probe it.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

const {
  mockInboxList, mockWiList, mockWiCreate, mockWiSetStatus, mockNotes, mockSchedule, mockNavigate,
} = vi.hoisted(() => ({
  mockInboxList: vi.fn(),
  mockWiList: vi.fn(),
  mockWiCreate: vi.fn(),
  mockWiSetStatus: vi.fn(),
  mockNotes: vi.fn(),
  mockSchedule: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    inbox: { list: mockInboxList, dismissReview: vi.fn(async () => {}), dismissMcp: vi.fn(async () => {}) },
    memory: { approve: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) },
    capabilities: { trustMcp: vi.fn(async () => ({})) },
    k: {
      workItems: { list: mockWiList, create: mockWiCreate, setStatus: mockWiSetStatus },
      notes: mockNotes,
      schedule: mockSchedule,
    },
  },
}))

vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import PersonalPage from '../src/pages/PersonalPage'

const EMPTY: InboxPayload = {
  items: [],
  counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0 },
  total: 0,
}

function renderPage(tab?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PersonalPage tab={tab} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockInboxList.mockReset(); mockWiList.mockReset(); mockWiCreate.mockReset(); mockWiSetStatus.mockReset()
  mockNotes.mockReset(); mockSchedule.mockReset(); mockNavigate.mockClear()
  mockInboxList.mockResolvedValue(EMPTY)
  mockWiList.mockResolvedValue([])
  mockNotes.mockResolvedValue([])
  mockSchedule.mockResolvedValue({ events: [], reminders: [] })
})
afterEach(() => cleanup())

describe('PersonalPage', () => {
  it('renders all 3 tabs — Chats folded into Messages (B.6)', async () => {
    renderPage()
    await screen.findByTestId('tab-inbox')
    expect(screen.getByTestId('tab-tasks')).toBeTruthy()
    expect(screen.getByTestId('tab-memories')).toBeTruthy()
    expect(screen.queryByTestId('tab-chats')).toBeNull()
  })

  it('defaults to the inbox tab and renders the real InboxTab', async () => {
    renderPage()
    const tab = await screen.findByTestId('tab-inbox')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('inbox-page')).toBeTruthy()
  })

  it('the tab prop selects the matching tab', async () => {
    renderPage('tasks')
    const tab = await screen.findByTestId('tab-tasks')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('tasks-workitems')).toBeTruthy()
  })

  it('an unknown tab param falls back to inbox', async () => {
    renderPage('bogus')
    const tab = await screen.findByTestId('tab-inbox')
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('clicking a tab navigates to personal/<tab>', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('tab-tasks'))
    expect(mockNavigate).toHaveBeenCalledWith('personal', 'tasks')

    fireEvent.click(await screen.findByTestId('tab-memories'))
    expect(mockNavigate).toHaveBeenCalledWith('personal', 'memories')
  })

  it("the inbox tab's count mirrors the mocked InboxPayload total", async () => {
    mockInboxList.mockResolvedValue({ ...EMPTY, total: 4 })
    renderPage()
    const tab = await screen.findByTestId('tab-inbox')
    await waitFor(() => expect(tab.textContent).toContain('4'))
  })

  it('shows no count badge when the inbox is empty', async () => {
    renderPage()
    const tab = await screen.findByTestId('tab-inbox')
    await waitFor(() => expect(mockInboxList).toHaveBeenCalled())
    expect(tab.textContent).toBe('Inbox')
  })
})
