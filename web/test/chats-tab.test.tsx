/**
 * ChatsTab (Personal hub, UI Simplification Task 15) — the thread MANAGEMENT
 * surface: lists ALL threads (including archived, `api.threads.list(true)`)
 * so an operator can rename/archive/unarchive/permanently delete any chat,
 * not just the non-archived ones Home's ChatView (Task 11) shows day-to-day.
 * `api.threads.*` is mocked at the same seam chat-view.test.tsx uses (no real
 * network); `thread-select.ts` is the REAL module so Open's `selectThread()`
 * call is observable via `getSelectedThread()` exactly like a real handoff to
 * Home's ChatView would see it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { KThreadSummary } from '@k/shared'

// jsdom has no matchMedia; ConfirmDialog's framer-motion AnimatePresence may probe it.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error - minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

const { mockThreadsList, mockThreadsUpdate, mockThreadsRemove, mockNavigate } = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockThreadsUpdate: vi.fn(),
  mockThreadsRemove: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      list: mockThreadsList,
      get: vi.fn(),
      create: vi.fn(),
      update: mockThreadsUpdate,
      remove: mockThreadsRemove,
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import ChatsTab from '../src/pages/personal/ChatsTab'
import { selectThread, getSelectedThread } from '../src/lib/thread-select'

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

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChatsTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  selectThread(null)
  try { localStorage.clear() } catch { /* storage unavailable */ }
  mockThreadsList.mockReset()
  mockThreadsUpdate.mockReset()
  mockThreadsRemove.mockReset()
  mockNavigate.mockReset()
  mockThreadsList.mockResolvedValue({ threads: [] })
  mockThreadsUpdate.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...thread({ id }), ...patch }))
  mockThreadsRemove.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

describe('ChatsTab', () => {
  it('lists ALL threads incl. archived (archived rows carry a chip)', async () => {
    const active = thread({ id: 'kt-1', title: 'Active chat' })
    const archived = thread({ id: 'kt-2', title: 'Old chat', archivedAt: Date.now() })
    mockThreadsList.mockResolvedValue({ threads: [active, archived] })
    renderTab()

    // FU-4: a real heading (h2), not an inert <span>.
    expect((await screen.findByText('All chats')).tagName).toBe('H2')
    await waitFor(() => expect(mockThreadsList).toHaveBeenCalledWith(true))
    expect(await screen.findByTestId('chats-row-kt-1')).toBeTruthy()
    expect(screen.getByTestId('chats-row-kt-2')).toBeTruthy()
    expect(screen.queryByTestId('chats-archived-kt-1')).toBeNull()
    expect(screen.getByTestId('chats-archived-kt-2')).toBeTruthy()
  })

  it('Open selects the thread, flips home view to chat, navigates home', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Pick me' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    renderTab()
    await screen.findByTestId('chats-row-kt-1')

    fireEvent.click(screen.getByTestId('chats-open-kt-1'))

    expect(getSelectedThread()).toBe('kt-1')
    expect(localStorage.getItem('k.home.view')).toBe('chat')
    expect(mockNavigate).toHaveBeenCalledWith('home')
  })

  it('archive/unarchive toggles via api.threads.update', async () => {
    const active = thread({ id: 'kt-1', archivedAt: null })
    mockThreadsList.mockResolvedValue({ threads: [active] })
    renderTab()
    await screen.findByTestId('chats-row-kt-1')

    fireEvent.click(screen.getByTestId('chats-archive-kt-1'))
    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { archived: true }))

    cleanup()
    const archived = thread({ id: 'kt-2', archivedAt: Date.now() })
    mockThreadsList.mockResolvedValue({ threads: [archived] })
    renderTab()
    await screen.findByTestId('chats-row-kt-2')

    fireEvent.click(screen.getByTestId('chats-archive-kt-2'))
    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-2', { archived: false }))
  })

  it('archiving the CURRENTLY-SELECTED thread demotes the selection to the next non-archived thread', async () => {
    // The T11 rule (mirrors ChatView's archive): an EXPLICIT archive moves the selection off
    // the thread — otherwise returning Home would land the operator parked on the archived
    // chip state. The next pick skips archived rows in this tab's include-archived list.
    const t1 = thread({ id: 'kt-1', title: 'Selected chat' })
    const tArch = thread({ id: 'kt-arch', title: 'Already archived', archivedAt: Date.now() })
    const t2 = thread({ id: 'kt-2', title: 'Next chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1, tArch, t2] })
    selectThread('kt-1')
    renderTab()
    await screen.findByTestId('chats-row-kt-1')

    fireEvent.click(screen.getByTestId('chats-archive-kt-1'))

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { archived: true }))
    // Longer timeout: the archive→demote runs through a mutation settle + effect, which can
    // exceed waitFor's 1s default under full-suite parallel load (flaked there; 10/10 solo).
    await waitFor(() => expect(getSelectedThread()).toBe('kt-2'), { timeout: 3000 }) // skips kt-arch (archived)
  })

  it('archiving a NON-selected thread leaves the selection alone', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Selected chat' })
    const t2 = thread({ id: 'kt-2', title: 'Other chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1, t2] })
    selectThread('kt-1')
    renderTab()
    await screen.findByTestId('chats-row-kt-2')

    fireEvent.click(screen.getByTestId('chats-archive-kt-2'))

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-2', { archived: true }))
    expect(getSelectedThread()).toBe('kt-1')
  })

  it('UNARCHIVING never touches the selection (even when the unarchived thread is selected)', async () => {
    const tArch = thread({ id: 'kt-arch', title: 'Archived chat', archivedAt: Date.now() })
    mockThreadsList.mockResolvedValue({ threads: [tArch] })
    selectThread('kt-arch')
    renderTab()
    await screen.findByTestId('chats-row-kt-arch')

    fireEvent.click(screen.getByTestId('chats-archive-kt-arch'))

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-arch', { archived: false }))
    expect(getSelectedThread()).toBe('kt-arch')
  })

  it('delete opens ConfirmDialog; confirm calls api.threads.remove; a 409 rejection surfaces in the dialog error', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Doomed chat' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    renderTab()
    await screen.findByTestId('chats-row-kt-1')

    fireEvent.click(screen.getByTestId('chats-delete-kt-1'))
    expect(await screen.findByTestId('chats-delete-confirm')).toBeTruthy()

    mockThreadsRemove.mockRejectedValueOnce(new Error('thread has a live run'))
    fireEvent.click(screen.getByTestId('chats-delete-confirm-confirm'))

    await waitFor(() => expect(mockThreadsRemove).toHaveBeenCalledWith('kt-1'))
    expect(await screen.findByTestId('chats-delete-confirm-error')).toBeTruthy()
    expect(screen.getByTestId('chats-delete-confirm-error').textContent).toContain('thread has a live run')
    // The dialog stays open on failure — confirm button is still there to retry.
    expect(screen.getByTestId('chats-delete-confirm-confirm')).toBeTruthy()

    // A retry that succeeds closes the dialog.
    mockThreadsList.mockResolvedValue({ threads: [] })
    fireEvent.click(screen.getByTestId('chats-delete-confirm-confirm'))
    await waitFor(() => expect(screen.queryByTestId('chats-delete-confirm')).toBeNull())
  })

  it('rename: pencil -> inline input -> Enter calls api.threads.update(id, {title})', async () => {
    const t1 = thread({ id: 'kt-1', title: 'Old title' })
    mockThreadsList.mockResolvedValue({ threads: [t1] })
    renderTab()
    await screen.findByTestId('chats-row-kt-1')

    fireEvent.click(screen.getByTestId('chats-rename-kt-1'))
    const input = screen.getByTestId('chats-rename-input-kt-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockThreadsUpdate).toHaveBeenCalledWith('kt-1', { title: 'New title' }))
  })

  it('a failing threads query surfaces an inline error, not a crash', async () => {
    mockThreadsList.mockRejectedValue(new Error('down'))
    renderTab()
    expect(await screen.findByTestId('chats-error')).toBeTruthy()
  })

  it('shows an empty state when there are no chats', async () => {
    mockThreadsList.mockResolvedValue({ threads: [] })
    renderTab()
    expect(await screen.findByTestId('chats-empty')).toBeTruthy()
  })
})
