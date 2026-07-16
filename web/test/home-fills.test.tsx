/**
 * home-fills.test.tsx (Impressive Wave FE Task 9) — five lightweight probes
 * for the NEW per-page fills this task wired into MessageDock/OverviewView/
 * WidgetShell/ChatView/ChatsTab. Full behavioral coverage for each surface
 * already lives in its own dedicated test file (message-dock.test.tsx,
 * overview-view.test.tsx, chat-view.test.tsx, chats-tab.test.tsx) — these
 * probes only prove the Task 9 surface area itself: dock-target dedup, the
 * empty-layout Customize CTA, WidgetShell's human widget name, ChatView's day
 * separators/timestamps/typing indicator, and ChatsTab's >5-thread search.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { KThreadSummary, KThreadTurn, HomeLayout } from '@k/shared'

const {
  mockThreadsList, mockThreadsGet, mockThreadsCreate, mockThreadsUpdate, mockThreadsRemove,
  mockAsk, mockUndo, mockHomeLayoutGet, mockHomeLayoutPut, mockUseAskPending,
} = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockThreadsGet: vi.fn(),
  mockThreadsCreate: vi.fn(),
  mockThreadsUpdate: vi.fn(),
  mockThreadsRemove: vi.fn(),
  mockAsk: vi.fn(),
  mockUndo: vi.fn(async () => ({ undone: true })),
  mockHomeLayoutGet: vi.fn(),
  mockHomeLayoutPut: vi.fn(),
  mockUseAskPending: vi.fn(() => null as string | null),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      list: mockThreadsList, get: mockThreadsGet, create: mockThreadsCreate,
      update: mockThreadsUpdate, remove: mockThreadsRemove,
    },
    k: { ask: mockAsk, undo: mockUndo },
    // MessageDock's @project picker + dispatch-card model picker query these
    // unconditionally (message-dock.test.tsx's same seam) — offline stubs.
    projects: { list: async () => [] },
    status: async () => ({
      claude: { available: true },
      ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
      github: { authenticated: false },
      auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
      voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
    }),
    claudeModel: { get: async () => ({ model: 'claude-sonnet-4-6', options: [] }) },
    voice: { transcribe: async () => ({ text: '' }) },
    homeLayout: { get: mockHomeLayoutGet, put: mockHomeLayoutPut },
  },
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
vi.mock('../src/lib/inbox-query', () => ({
  INBOX_KEY: ['inbox'],
  inboxQueryFn: async () => ({ items: [], counts: {}, total: 0 }),
  // NeedsYouWidget imports this constant directly (`data ?? EMPTY_INBOX`) — a mock
  // factory that omits it throws "No EMPTY_INBOX export" the moment NeedsYouWidget
  // renders (e.g. DEFAULT_LAYOUT's transient pre-`loaded` flash in probe 2), caught
  // silently by WidgetErrorBoundary. Shape matches the real module's EMPTY_INBOX.
  EMPTY_INBOX: {
    items: [],
    counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0, proposal: 0 },
    total: 0,
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
// Step 4's typing indicator — controllable per-test via mockUseAskPending's return value.
vi.mock('../src/lib/ask-pending', () => ({ useAskPending: mockUseAskPending, setAskPending: vi.fn() }))

import MessageDock from '../src/shell/MessageDock'
import OverviewView from '../src/pages/home/OverviewView'
import WidgetShell from '../src/pages/home/WidgetShell'
import ChatView from '../src/pages/home/ChatView'
import ChatsTab from '../src/pages/personal/ChatsTab'
import { selectThread } from '../src/lib/thread-select'

// jsdom has no scrollIntoView — ChatView's transcript tail-sentinel needs it stubbed
// (mirrors chat-view.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function thread(over: Partial<KThreadSummary>): KThreadSummary {
  return {
    id: 'kt-1', title: 'Untitled', status: 'idle', activeRunId: null, archivedAt: null,
    createdAt: 0, updatedAt: 0, snippet: null, lastTurnAt: null, ...over,
  }
}
function turn(over: Partial<KThreadTurn>): KThreadTurn {
  return { id: 't-1', threadId: 'kt-1', role: 'user', text: 'hello', runId: null, createdAt: 0, ...over }
}

function qcRender(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  selectThread(null)
  mockThreadsList.mockReset()
  mockThreadsGet.mockReset()
  mockThreadsCreate.mockReset()
  mockThreadsUpdate.mockReset()
  mockThreadsRemove.mockReset()
  mockAsk.mockReset()
  mockHomeLayoutGet.mockReset()
  mockHomeLayoutPut.mockReset()
  mockUseAskPending.mockReset()
  mockUseAskPending.mockReturnValue(null)
  mockThreadsList.mockResolvedValue({ threads: [] })
  mockThreadsGet.mockResolvedValue({ thread: thread({}), turns: [] })
  mockHomeLayoutGet.mockResolvedValue({ layout: null })
  mockHomeLayoutPut.mockResolvedValue({ layout: null })
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

describe('home-fills (Task 9 probes)', () => {
  it('1. MessageDock: showTarget dedup — no dock-target for a null selection, present for a real one', async () => {
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-9', title: 'Refactor the router' })] })
    qcRender(<MessageDock variant="bar" />)
    await screen.findByTestId('dock-input')
    expect(screen.queryByTestId('dock-target')).toBeNull()

    cleanup()
    selectThread('kt-9')
    qcRender(<MessageDock variant="bar" />)
    await waitFor(() => expect(screen.getByTestId('dock-target').textContent).toContain('Refactor the router'))
  })

  it('2. OverviewView: an empty saved layout renders the Customize CTA empty-state', async () => {
    mockHomeLayoutGet.mockResolvedValue({ layout: { widgets: [] } })
    qcRender(<OverviewView />)
    expect(await screen.findByText('Your overview is empty')).toBeTruthy()
    // Two "Customize" affordances render while empty: the header toggle + the CTA button.
    await waitFor(() => expect(screen.getAllByText('Customize').length).toBe(2))
  })

  it('3. WidgetShell: placement id active_runs shows the human name "Active runs"', () => {
    const layout: HomeLayout = { widgets: [{ id: 'active_runs', x: 0, y: 0, w: 1, h: 1 }] }
    render(<WidgetShell placement={layout.widgets[0]} layout={layout} onChange={() => {}} />)
    expect(screen.getByText('Active runs')).toBeTruthy()
  })

  it('4. ChatView: turns on two days render a day separator per day + per-turn times; a pending ask renders chat-typing', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Two-day chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    mockThreadsGet.mockResolvedValue({
      thread: t1,
      turns: [
        turn({ id: 'tn-1', createdAt: Date.now() - 2 * 86_400_000, text: 'old message' }),
        turn({ id: 'tn-2', role: 'k', createdAt: Date.now(), text: 'new message' }),
      ],
    })
    selectThread('kt-1')
    qcRender(<ChatView />)

    await waitFor(() => expect(screen.getAllByTestId('chat-day-separator').length).toBe(2))
    expect(screen.getByTestId('chat-turn-user').textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(screen.queryByTestId('chat-typing')).toBeNull()

    cleanup()
    mockUseAskPending.mockReturnValue('kt-1')
    qcRender(<ChatView />)
    await waitFor(() => expect(screen.getByTestId('chat-typing')).toBeTruthy())
  })

  it('5. ChatsTab: 6 threads render a search input that filters the list by title', async () => {
    const many = Array.from({ length: 6 }, (_, i) => thread({ id: `kt-${i}`, title: `Chat number ${i}` }))
    mockThreadsList.mockResolvedValue({ threads: many })
    qcRender(<ChatsTab />)

    const search = await screen.findByTestId('chats-search')
    await waitFor(() => expect(screen.getByTestId('chats-row-kt-0')).toBeTruthy())
    expect(screen.getByTestId('chats-row-kt-5')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'number 3' } })
    await waitFor(() => expect(screen.queryByTestId('chats-row-kt-0')).toBeNull())
    expect(screen.getByTestId('chats-row-kt-3')).toBeTruthy()
  })
})
