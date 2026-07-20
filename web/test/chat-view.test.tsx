/**
 * ChatView (UI Simplification Task 11) — Home's chat pane: a thread-list rail
 * (rename/archive row actions, "+ New chat") + the selected thread's
 * transcript (user/K bubbles, run action chips). Mocks `api.threads.*` at the
 * same seam message-dock.test.tsx uses (no real network); `thread-select.ts`
 * is the REAL module (a process-wide store) so `selectThread()` drives the
 * component exactly as MessageDock would — beforeEach resets it so tests
 * don't leak selection into each other.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { KThreadSummary, KThreadTurn } from '@k/shared'

const { mockThreadsList, mockThreadsGet, mockThreadsUpdate, mockNavigate } = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockThreadsGet: vi.fn(),
  mockThreadsUpdate: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      list: mockThreadsList,
      get: mockThreadsGet,
      update: mockThreadsUpdate,
      create: vi.fn(),
      remove: vi.fn(),
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import ChatView from '../src/pages/home/ChatView'
import { selectThread, getSelectedThread } from '../src/lib/thread-select'

// jsdom has no scrollIntoView — the transcript's tail-sentinel auto-scroll
// needs it stubbed (mirrors run-timeline.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function thread(over: Partial<KThreadSummary>): KThreadSummary {
  return {
    id: 'kt-1',
    title: 'Untitled',
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

function turn(over: Partial<KThreadTurn>): KThreadTurn {
  return {
    id: 't-1',
    threadId: 'kt-1',
    role: 'user',
    text: 'hello',
    runId: null,
    createdAt: 0,
    ...over,
  }
}

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChatView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  selectThread(null)
  mockThreadsList.mockReset()
  mockThreadsGet.mockReset()
  mockThreadsUpdate.mockReset()
  mockNavigate.mockReset()
  mockThreadsList.mockResolvedValue({ threads: [] })
  mockThreadsGet.mockResolvedValue({ thread: thread({}), turns: [] })
  mockThreadsUpdate.mockResolvedValue(thread({}))
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

describe('ChatView', () => {
  it('lists non-archived threads newest-first and renders the selected transcript', async () => {
    const t1 = thread({ id: 'kt-1', title: 'First chat', snippet: 'hi there', lastTurnAt: Date.now() })
    const t2 = thread({ id: 'kt-2', title: 'Second chat', snippet: 'yo', lastTurnAt: Date.now() })
    // Server already orders newest-first (kThreadsDb.listThreads) — the component
    // must render in the order it receives, not re-sort client-side.
    mockThreadsList.mockResolvedValue({ threads: [t2, t1] })
    mockThreadsGet.mockImplementation(async (id: string) => ({
      thread: id === 'kt-2' ? t2 : t1,
      turns: id === 'kt-2' ? [turn({ id: 'tn-1', threadId: 'kt-2', role: 'user', text: 'yo' })] : [],
    }))
    selectThread('kt-2')
    renderChat()

    // FU-4: the rail's SectionHeader is a real heading (h2), not an inert <span>.
    expect((await screen.findByText('Chats')).tagName).toBe('H2')
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-2')).toBeTruthy())
    const rows = screen.getAllByTestId(/^chat-thread-row-/)
    expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['chat-thread-row-kt-2', 'chat-thread-row-kt-1'])
    await waitFor(() => expect(screen.getByTestId('conversation-turn-user').textContent).toContain('yo'))
  })

  it('clicking a thread row selects it (thread-select store) and swaps the transcript', async () => {
    const t1 = thread({ id: 'kt-1', title: 'First chat' })
    const t2 = thread({ id: 'kt-2', title: 'Second chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1, t2] })
    mockThreadsGet.mockImplementation(async (id: string) => ({
      thread: id === 'kt-1' ? t1 : t2,
      turns: [turn({ id: `turn-${id}`, threadId: id, role: 'k', text: `reply in ${id}` })],
    }))
    selectThread('kt-1')
    renderChat()
    await waitFor(() => expect(screen.getByTestId('conversation-turn-agent').textContent).toContain('reply in kt-1'))

    fireEvent.click(screen.getByText('Second chat'))

    await waitFor(() => expect(getSelectedThread()).toBe('kt-2'))
    await waitFor(() => expect(screen.getByTestId('conversation-turn-agent').textContent).toContain('reply in kt-2'))
  })

  it('rename: pencil -> inline input -> Enter calls api.threads.update(id, {title})', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Old title' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('chat-rename-kt-1'))
    const input = screen.getByTestId('chat-rename-input-kt-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { title: 'New title' }))
  })

  it('archive: calls api.threads.update(id, {archived:true}); selection falls back to most recent remaining', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Older', updatedAt: 1 })
    const t2 = thread({ id: 'kt-2', title: 'Newer', updatedAt: 2 })
    // First read: both present. After the archive mutation invalidates ['k-threads'],
    // the refetch reflects the server's default (archived excluded) — kt-1 is gone.
    mockThreadsList
      .mockResolvedValueOnce({ threads: [t2, t1] })
      .mockResolvedValue({ threads: [t2] })
    mockThreadsUpdate.mockResolvedValue({ ...t1, archivedAt: Date.now() })
    selectThread('kt-1')
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('chat-archive-kt-1'))

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { archived: true }))
    await waitFor(() => expect(getSelectedThread()).toBe('kt-2'))
  })

  it('a turn with runId renders an action chip that navigates to the run console', async () => {
    const t1 = thread({ id: 'kt-1' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    mockThreadsGet.mockResolvedValue({
      thread: t1,
      turns: [turn({ id: 'tn-1', threadId: 'kt-1', role: 'k', text: 'routed it', runId: 'run-9' })],
    })
    selectThread('kt-1')
    renderChat()

    const chip = await screen.findByTestId('conversation-run-chip')
    fireEvent.click(chip)
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-9')
  })

  it('with zero threads, shows the empty new-chat state (no crash)', async () => {
    mockThreadsList.mockResolvedValue({ threads: [] })
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeTruthy())
    expect(screen.queryAllByTestId(/^chat-thread-row-/).length).toBe(0)
  })

  it('dock create race: a selection missing from a stale settled list is NOT demoted — one refetch confirms it first', async () => {
    // Repro of the reviewer-verified Critical: MessageDock.submit() on a new
    // chat does threads.create() -> selectThread(created.id) -> ask.send(...),
    // and the ['k-threads'] invalidation only lands AFTER the ask round-trip.
    // In that window ChatView's cached list is settled-and-stale (no such id):
    // the fallback must NOT demote the just-created selection — it probes with
    // ONE list refetch (fetched after the create, so it includes the id) and
    // keeps the selection.
    const t1 = thread({ id: 'kt-1', title: 'Existing chat' })
    const tNew = thread({ id: 'kt-new', title: 'New chat' })
    mockThreadsList
      .mockResolvedValueOnce({ threads: [t1] }) // pre-create snapshot
      .mockResolvedValue({ threads: [tNew, t1] }) // any fetch after the create sees it
    mockThreadsGet.mockImplementation(async (id: string) => ({
      thread: id === 'kt-new' ? tNew : t1,
      turns: id === 'kt-new'
        ? [turn({ id: 'tn-new', threadId: 'kt-new', role: 'user', text: 'first message' })]
        : [],
    }))
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    // What the dock does milliseconds after threads.create() resolves.
    act(() => { selectThread('kt-new') })

    // The stale settled list must not overwrite the selection...
    expect(getSelectedThread()).toBe('kt-new')
    // ...it triggers exactly one probe refetch of ['k-threads'] instead...
    await waitFor(() => expect(mockThreadsList).toHaveBeenCalledTimes(2))
    expect(getSelectedThread()).toBe('kt-new')
    // ...and once the refreshed list includes the id it stays selected, with
    // its transcript query enabled (turns render).
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-new')).toBeTruthy())
    expect(getSelectedThread()).toBe('kt-new')
    expect(mockThreadsGet).toHaveBeenCalledWith('kt-new')
    await waitFor(() => expect(screen.getByTestId('conversation-turn-user').textContent).toContain('first message'))
    expect(mockThreadsList).toHaveBeenCalledTimes(2) // exactly one probe — no refetch loop
  })

  it('a selection absent even from a fresh refetch IS demoted to the newest remaining thread', async () => {
    // The genuinely-unknown-id case (deleted elsewhere): the probe refetch
    // lands AFTER the selection was made and still lacks the id — only now
    // does the fallback demote to the most recent non-archived thread.
    const t1 = thread({ id: 'kt-1', title: 'Existing chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1] }) // never contains kt-ghost
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    act(() => { selectThread('kt-ghost') })

    await waitFor(() => expect(mockThreadsList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getSelectedThread()).toBe('kt-1'))
    expect(mockThreadsList).toHaveBeenCalledTimes(2) // one probe, then it settles
  })

  it('an archived selection (opened from Chats/Memories) is KEPT with its transcript + an archived indicator — never demoted', async () => {
    // Opening an archived thread from ChatsTab/MemoriesTab selects an id ABSENT from the
    // default (non-archived) list. The probe must distinguish archived-but-existing (KEEP)
    // from deleted (demote) via a by-id read — so the operator lands on the chat they opened,
    // not a different conversation the probe demoted them onto.
    const active = thread({ id: 'kt-1', title: 'Active chat' })
    const archived = thread({ id: 'kt-arch', title: 'Archived plan', archivedAt: Date.now() })
    mockThreadsList.mockResolvedValue({ threads: [active] }) // the default list excludes the archived one
    mockThreadsGet.mockImplementation(async (id: string) => ({
      thread: id === 'kt-arch' ? archived : active,
      turns: id === 'kt-arch'
        ? [turn({ id: 'tn-a', threadId: 'kt-arch', role: 'user', text: 'archived message' })]
        : [],
    }))
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    act(() => { selectThread('kt-arch') })

    // One probe refetch confirms kt-arch is absent from the default list; the by-id read then
    // proves it EXISTS (archived) — so the selection is KEPT (not demoted to kt-1)…
    await waitFor(() => expect(mockThreadsList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('conversation-turn-user').textContent).toContain('archived message'))
    expect(getSelectedThread()).toBe('kt-arch')
    // …and the chat surface is honest that the thread is archived.
    expect(screen.getByTestId('chat-archived-indicator')).toBeTruthy()
    expect(mockThreadsList).toHaveBeenCalledTimes(2) // exactly one probe — no refetch loop
  })

  it('a DELETED selection (by-id 404) IS still demoted to the newest remaining thread — no archived chip', async () => {
    // The control: a genuinely-deleted id 404s on the by-id read (unlike an archived thread,
    // which resolves) — so it is demoted exactly as before, and no archived indicator shows.
    const active = thread({ id: 'kt-1', title: 'Active chat' })
    mockThreadsList.mockResolvedValue({ threads: [active] })
    mockThreadsGet.mockImplementation(async (id: string) => {
      if (id === 'kt-del') throw new Error('not found')
      return { thread: active, turns: [] }
    })
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    act(() => { selectThread('kt-del') })

    await waitFor(() => expect(mockThreadsList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getSelectedThread()).toBe('kt-1'))
    expect(screen.queryByTestId('chat-archived-indicator')).toBeNull()
  })

  it('EXPLICITLY archiving the OPEN thread moves the selection to the next thread — no archived chip (T11 rule)', async () => {
    // The rule: an EXPLICIT archive action moves the selection off the thread; only NAVIGATING
    // to an already-archived thread keeps it (the probe's keep+chip flow above). The by-id read
    // here reflects the server's honest post-archive state (archivedAt set) — without the
    // explicit-archive demotion, the probe would prove kt-1 archived-but-live and KEEP it
    // parked on the chip state instead of falling to the next conversation.
    const t1 = thread({ id: 'kt-1', title: 'Open chat' })
    const t2 = thread({ id: 'kt-2', title: 'Other chat' })
    mockThreadsList
      .mockResolvedValueOnce({ threads: [t1, t2] }) // pre-archive snapshot
      .mockResolvedValue({ threads: [t2] }) // any fetch after the archive excludes kt-1
    mockThreadsGet.mockImplementation(async (id: string) => ({
      thread: id === 'kt-1' ? { ...t1, archivedAt: Date.now() } : t2,
      turns: [],
    }))
    mockThreadsUpdate.mockResolvedValue({ ...t1, archivedAt: Date.now() })
    selectThread('kt-1')
    renderChat()
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('chat-archive-kt-1'))

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { archived: true }))
    await waitFor(() => expect(getSelectedThread()).toBe('kt-2'))
    // The next conversation renders — never the archived chip state.
    await waitFor(() => expect(screen.getByTestId('chat-thread-row-kt-2')).toBeTruthy())
    expect(screen.queryByTestId('chat-archived-indicator')).toBeNull()
  })

  it('a failing threads query degrades to the empty state — chat never hard-blocks (spec §9)', async () => {
    // A real prior selection existed (persisted from an earlier, working session) —
    // the list read failing must still degrade the TRANSCRIPT to the empty state
    // rather than crash or hang, while leaving the persisted selection alone (a
    // transient fetch failure should not silently wipe it).
    selectThread('kt-1')
    mockThreadsList.mockRejectedValue(new Error('boom'))
    renderChat()

    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeTruthy())
    expect(screen.queryAllByTestId(/^chat-thread-row-/).length).toBe(0)
    expect(getSelectedThread()).toBe('kt-1')
  })
})
