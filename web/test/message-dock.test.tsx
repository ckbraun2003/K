/**
 * MessageDock (UI Simplification Task 8) — bar + float variants share one
 * Composer: destination label, per-thread drafts, the expander's model/force-route
 * selects, the send-anchored undo toast (CommandBar/KHome idiom), and (float only)
 * a focus-trapped overlay with a thread picker behind a floating fab. Mocks api,
 * ws, and inbox-query at the same seams activity-strip.test.tsx / command-bar-ask-k
 * .test.tsx use — no real network. thread-select.ts is the REAL module (a
 * process-wide store) so selectThread() drives the component exactly as a sibling
 * surface would; beforeEach resets it so tests don't leak selection into each other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import type { KThreadSummary } from '@k/shared'

// framer-motion's rAF frameloop can stall a fake-timers test — mirrors
// command-bar-ask-k.test.tsx's guard so the undo toast's exit is deterministic.
MotionGlobalConfig.skipAnimations = true

const { mockThreadsList, mockThreadsCreate, mockAsk, mockUndo, mockInbox } = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockThreadsCreate: vi.fn(),
  mockAsk: vi.fn(),
  mockUndo: vi.fn(async () => ({ undone: true })),
  mockInbox: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: { list: mockThreadsList, get: vi.fn(), create: mockThreadsCreate },
    k: { ask: mockAsk, undo: mockUndo },
    claudeModel: {
      get: async () => ({
        model: 'claude-sonnet-4-6',
        options: [
          { id: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ],
      }),
    },
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
// Mirrors activity-strip.test.tsx's mock of runs-query: the dock's badge reads
// this module directly, so control it here instead of the underlying api.inbox.
vi.mock('../src/lib/inbox-query', () => ({
  INBOX_KEY: ['inbox'],
  inboxQueryFn: mockInbox,
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import MessageDock from '../src/shell/MessageDock'
import { selectThread } from '../src/lib/thread-select'

function thread(over: Partial<KThreadSummary>): KThreadSummary {
  return {
    id: over.id ?? 'kt-1',
    title: over.title ?? 'Untitled',
    status: 'idle',
    activeRunId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    snippet: null,
    lastTurnAt: null,
    ...over,
  }
}

function renderDock(variant: 'bar' | 'float' = 'bar') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageDock variant={variant} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // jsdom has no scrollIntoView / MediaRecorder — MicButton degrades gracefully
  // (see mic-button.test.tsx), nothing extra to stub here.
  selectThread(null)
  mockThreadsList.mockReset()
  mockThreadsCreate.mockReset()
  mockAsk.mockReset()
  mockUndo.mockClear()
  mockInbox.mockReset()
  mockThreadsList.mockResolvedValue({ threads: [] })
  mockInbox.mockResolvedValue({ items: [], counts: {}, total: 0 })
  mockAsk.mockImplementation(async (message: string, opts?: { threadId?: string }) => ({
    kThreadId: opts?.threadId ?? 'kt', agentRunId: 'ar', runId: 'run-123',
    route: { target: 'k', label: 'K answers directly', escalates: false }, warm: false,
  }))
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

describe('MessageDock', () => {
  it('bar variant shows the selected chat title as the destination label', async () => {
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-9', title: 'Refactor the router' })] })
    renderDock('bar')
    act(() => { selectThread('kt-9') })
    await waitFor(() => expect(screen.getByTestId('dock-target').textContent).toBe('→ Refactor the router'))
  })

  it('shows "New chat" as the destination label when selection is null', async () => {
    renderDock('bar')
    expect(await screen.findByTestId('dock-target')).toHaveProperty('textContent', '→ New chat')
  })

  it('sending with null selection creates a thread first, then asks with its id', async () => {
    mockThreadsCreate.mockResolvedValue({ id: 'kt-new', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 0, updatedAt: 0 })
    renderDock('bar')
    fireEvent.change(screen.getByTestId('dock-input'), { target: { value: 'hello K' } })
    fireEvent.click(screen.getByTestId('dock-send'))

    await waitFor(() => expect(mockThreadsCreate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith('hello K', expect.objectContaining({ threadId: 'kt-new' }))
  })

  it('sends to the already-selected thread without creating a new one', async () => {
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-5', title: 'Existing' })] })
    renderDock('bar')
    act(() => { selectThread('kt-5') })
    await screen.findByText('→ Existing')

    fireEvent.change(screen.getByTestId('dock-input'), { target: { value: 'follow up' } })
    fireEvent.click(screen.getByTestId('dock-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith('follow up', expect.objectContaining({ threadId: 'kt-5' }))
    expect(mockThreadsCreate).not.toHaveBeenCalled()
  })

  it('drafts survive switching threads', async () => {
    mockThreadsList.mockResolvedValue({
      threads: [thread({ id: 'kt-a', title: 'A' }), thread({ id: 'kt-b', title: 'B' })],
    })
    renderDock('bar')
    act(() => { selectThread('kt-a') })
    await screen.findByText('→ A')

    const input = screen.getByTestId('dock-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft for A' } })

    act(() => { selectThread('kt-b') })
    await waitFor(() => expect(screen.getByText('→ B')).toBeTruthy())
    expect((screen.getByTestId('dock-input') as HTMLInputElement).value).toBe('')

    act(() => { selectThread('kt-a') })
    await waitFor(() => expect(screen.getByText('→ A')).toBeTruthy())
    expect((screen.getByTestId('dock-input') as HTMLInputElement).value).toBe('draft for A')
  })

  it('float variant: fab opens a focus-trapped overlay; Esc closes and restores focus', async () => {
    renderDock('float')
    const fab = screen.getByTestId('dock-fab')
    fireEvent.click(fab)

    const overlay = await screen.findByTestId('dock-overlay')
    expect(overlay).toBeTruthy()
    expect(screen.getByTestId('dock-input')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('dock-overlay')).toBeNull())
    expect(document.activeElement).toBe(fab)
  })

  it('fab shows the inbox needs-you badge', async () => {
    mockInbox.mockResolvedValue({ items: [], counts: {}, total: 4 })
    renderDock('float')
    expect((await screen.findByTestId('dock-fab-badge')).textContent).toBe('4')
  })

  it('does not show a badge when the inbox is empty', async () => {
    renderDock('float')
    await screen.findByTestId('dock-fab')
    expect(screen.queryByTestId('dock-fab-badge')).toBeNull()
  })

  it('focusDock() focuses the bar input', async () => {
    const { focusDock } = await import('../src/lib/dock-bus')
    renderDock('bar')
    const input = await screen.findByTestId('dock-input')
    input.blur()
    expect(document.activeElement).not.toBe(input)
    act(() => { focusDock() })
    expect(document.activeElement).toBe(input)
  })

  it('focusDock() opens the float overlay and focuses its input', async () => {
    const { focusDock } = await import('../src/lib/dock-bus')
    renderDock('float')
    expect(screen.queryByTestId('dock-overlay')).toBeNull()
    act(() => { focusDock() })
    await waitFor(() => expect(screen.getByTestId('dock-overlay')).toBeTruthy())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('dock-input')))
  })

  it('a failed send surfaces ask.error inline (testid dock-error) and keeps the draft', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-5', title: 'Existing' })] })
    renderDock('bar')
    act(() => { selectThread('kt-5') })
    await screen.findByText('→ Existing')

    const input = screen.getByTestId('dock-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'this will fail' } })
    fireEvent.click(screen.getByTestId('dock-send'))

    await screen.findByTestId('dock-error')
    expect(screen.getByTestId('dock-error').textContent).toMatch(/kaboom/)
    expect(input.value).toBe('this will fail')
  })

  it('a failed thread-create (new-chat send) surfaces dock-error and keeps the draft', async () => {
    // Review fix: the lazy create on a null-selection send is a distinct failure
    // point BEFORE ask.send — unwrapped, it was an unhandled rejection with no
    // user feedback (dock-error never shown, draft apparently swallowed).
    mockThreadsCreate.mockRejectedValueOnce(new Error('create blew up'))
    renderDock('bar')

    const input = screen.getByTestId('dock-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'first message' } })
    fireEvent.click(screen.getByTestId('dock-send'))

    await screen.findByTestId('dock-error')
    expect(screen.getByTestId('dock-error').textContent).toMatch(/create blew up/)
    expect(input.value).toBe('first message')
    expect(mockAsk).not.toHaveBeenCalled()
  })

  it('clicking a picker thread row switches the selection (float overlay)', async () => {
    const { getSelectedThread } = await import('../src/lib/thread-select')
    mockThreadsList.mockResolvedValue({
      threads: [thread({ id: 'kt-a', title: 'Alpha' }), thread({ id: 'kt-b', title: 'Beta' })],
    })
    renderDock('float')
    fireEvent.click(screen.getByTestId('dock-fab'))
    await screen.findByTestId('dock-thread-picker')

    fireEvent.click(await screen.findByTestId('dock-picker-thread-kt-b'))
    await waitFor(() => expect(screen.getByTestId('dock-target').textContent).toBe('→ Beta'))
    expect(getSelectedThread()).toBe('kt-b')

    // And the picker's New-chat row resets it back to a new-chat draft.
    fireEvent.click(screen.getByTestId('dock-picker-new-chat'))
    await waitFor(() => expect(screen.getByTestId('dock-target').textContent).toBe('→ New chat'))
    expect(getSelectedThread()).toBeNull()
  })

  it('the expander reveals the model + force-route selects', async () => {
    renderDock('bar')
    expect(screen.queryByTestId('dock-model-select')).toBeNull()
    fireEvent.click(screen.getByTestId('dock-expander'))
    expect(await screen.findByTestId('dock-model-select')).toBeTruthy()
    expect(screen.getByTestId('dock-force-route')).toBeTruthy()
  })

  it('+ New chat sets the selection to null', async () => {
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-5', title: 'Existing' })] })
    renderDock('bar')
    act(() => { selectThread('kt-5') })
    await screen.findByText('→ Existing')

    fireEvent.click(screen.getByTestId('dock-new-chat'))
    await waitFor(() => expect(screen.getByTestId('dock-target').textContent).toBe('→ New chat'))
  })

  it('a successful send raises the undo toast; Undo calls api.k.undo', async () => {
    mockThreadsList.mockResolvedValue({ threads: [thread({ id: 'kt-5', title: 'Existing' })] })
    renderDock('bar')
    act(() => { selectThread('kt-5') })
    await screen.findByText('→ Existing')

    fireEvent.change(screen.getByTestId('dock-input'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('dock-send'))

    const undo = await screen.findByTestId('dock-undo')
    expect(screen.getByTestId('dock-undo-toast')).toBeTruthy()
    fireEvent.click(undo)
    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('run-123'))
  })
})
