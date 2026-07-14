/**
 * MemoriesTab (Personal hub, UI Simplification Task 15) — the operator-memory
 * surface: `UserMemory` rows (`api.memories.*`, Task 7/3), distinct from the
 * agent-memory Lessons review queue (MemoryPage.tsx). Add/edit/delete are all
 * exercised here; delete is confirm-gated (ConfirmDialog) like ChatsTab's.
 * `api.memories.*` and `route.navigate` are mocked; `thread-select.ts` is the
 * REAL module so the source-chat link's handoff is observable exactly like a
 * real one would be.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UserMemory } from '@k/shared'

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

const { mockMemoriesList, mockMemoriesCreate, mockMemoriesUpdate, mockMemoriesRemove, mockNavigate } = vi.hoisted(() => ({
  mockMemoriesList: vi.fn(),
  mockMemoriesCreate: vi.fn(),
  mockMemoriesUpdate: vi.fn(),
  mockMemoriesRemove: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    memories: {
      list: mockMemoriesList,
      create: mockMemoriesCreate,
      update: mockMemoriesUpdate,
      remove: mockMemoriesRemove,
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import MemoriesTab from '../src/pages/personal/MemoriesTab'
import { selectThread, getSelectedThread } from '../src/lib/thread-select'

function memory(over: Partial<UserMemory>): UserMemory {
  return {
    id: 'um-1',
    content: 'Remember this',
    sourceThreadId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoriesTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  selectThread(null)
  try { localStorage.clear() } catch { /* storage unavailable */ }
  mockMemoriesList.mockReset()
  mockMemoriesCreate.mockReset()
  mockMemoriesUpdate.mockReset()
  mockMemoriesRemove.mockReset()
  mockNavigate.mockReset()
  mockMemoriesList.mockResolvedValue({ memories: [] })
  mockMemoriesCreate.mockResolvedValue(memory({}))
  mockMemoriesUpdate.mockResolvedValue(memory({}))
  mockMemoriesRemove.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

describe('MemoriesTab', () => {
  it('lists memories with relative time and a source-chat link only when sourceThreadId is set', async () => {
    const m1 = memory({ id: 'um-1', content: 'Loves TDD', updatedAt: Date.now(), sourceThreadId: 'kt-9' })
    const m2 = memory({ id: 'um-2', content: 'No source', updatedAt: Date.now(), sourceThreadId: null })
    mockMemoriesList.mockResolvedValue({ memories: [m1, m2] })
    renderTab()

    // FU-4: a real heading (h2), not an inert <span>.
    expect((await screen.findByText('Memories')).tagName).toBe('H2')
    expect(await screen.findByTestId('memories-row-um-1')).toBeTruthy()
    expect(screen.getByText('Loves TDD')).toBeTruthy()
    expect(screen.getByText('No source')).toBeTruthy()
    expect(screen.getByTestId('memories-source-um-1')).toBeTruthy()
    expect(screen.queryByTestId('memories-source-um-2')).toBeNull()
  })

  it('add: textarea + button posts via api.memories.create and clears on success', async () => {
    mockMemoriesList.mockResolvedValue({ memories: [] })
    renderTab()
    await screen.findByTestId('memories-empty')

    const textarea = screen.getByTestId('memories-add-input') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'New fact' } })
    fireEvent.click(screen.getByTestId('memories-add'))

    await waitFor(() => expect(mockMemoriesCreate).toHaveBeenCalledWith('New fact'))
    await waitFor(() => expect(textarea.value).toBe(''))
  })

  it('edit inline: Edit -> AutoTextarea -> Enter calls api.memories.update', async () => {
    const m1 = memory({ id: 'um-1', content: 'Old fact' })
    mockMemoriesList.mockResolvedValue({ memories: [m1] })
    renderTab()
    await screen.findByTestId('memories-row-um-1')

    fireEvent.click(screen.getByTestId('memories-edit-um-1'))
    const input = screen.getByTestId('memories-edit-input-um-1') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'New fact' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockMemoriesUpdate).toHaveBeenCalledWith('um-1', 'New fact'))
  })

  it('delete: Delete -> ConfirmDialog -> confirm calls api.memories.remove', async () => {
    const m1 = memory({ id: 'um-1', content: 'To be deleted' })
    mockMemoriesList.mockResolvedValue({ memories: [m1] })
    renderTab()
    await screen.findByTestId('memories-row-um-1')

    fireEvent.click(screen.getByTestId('memories-delete-um-1'))
    expect(await screen.findByTestId('memories-delete-confirm')).toBeTruthy()

    fireEvent.click(screen.getByTestId('memories-delete-confirm-confirm'))

    await waitFor(() => expect(mockMemoriesRemove).toHaveBeenCalledWith('um-1'))
  })

  it('a failed delete surfaces inline in the dialog and keeps it open', async () => {
    const m1 = memory({ id: 'um-1', content: 'Sticky' })
    mockMemoriesList.mockResolvedValue({ memories: [m1] })
    mockMemoriesRemove.mockRejectedValueOnce(new Error('store down'))
    renderTab()
    await screen.findByTestId('memories-row-um-1')

    fireEvent.click(screen.getByTestId('memories-delete-um-1'))
    fireEvent.click(screen.getByTestId('memories-delete-confirm-confirm'))

    expect(await screen.findByTestId('memories-delete-confirm-error')).toBeTruthy()
    expect(screen.getByTestId('memories-delete-confirm-confirm')).toBeTruthy()
  })

  it('the source-chat link selects the thread, flips home view to chat, navigates home', async () => {
    const m1 = memory({ id: 'um-1', content: 'linked', sourceThreadId: 'kt-9' })
    mockMemoriesList.mockResolvedValue({ memories: [m1] })
    renderTab()
    await screen.findByTestId('memories-source-um-1')

    fireEvent.click(screen.getByTestId('memories-source-um-1'))

    expect(getSelectedThread()).toBe('kt-9')
    expect(localStorage.getItem('k.home.view')).toBe('chat')
    expect(mockNavigate).toHaveBeenCalledWith('home')
  })

  it('shows the empty-state sentence when there are no memories', async () => {
    mockMemoriesList.mockResolvedValue({ memories: [] })
    renderTab()
    expect(await screen.findByTestId('memories-empty')).toBeTruthy()
    expect(screen.getByTestId('memories-empty').textContent).toBe(
      'K will remember things from your chats here — or add one yourself.',
    )
  })

  it('a failing memories query surfaces an inline error, not a crash', async () => {
    mockMemoriesList.mockRejectedValue(new Error('down'))
    renderTab()
    expect(await screen.findByTestId('memories-error')).toBeTruthy()
  })
})
