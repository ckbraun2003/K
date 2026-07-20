/** MessagesPage (Continuous Agents B.6) — grouping, unread badges, read-marking.
 *  Plus the ChatsTab-parity management surface on K rows (rename/archive/delete/
 *  archived-toggle/search + selection demotion) — coverage carried over from the
 *  retired chats-tab.test.tsx (B.0 decision 9: zero capability loss). */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MessagesPage from '../src/pages/MessagesPage'

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

const conv = (over: Record<string, unknown>) => ({
  id: 'kt-x', title: null, status: 'idle', activeRunId: null, archivedAt: null,
  createdAt: 1, updatedAt: 1, snippet: null, lastTurnAt: null,
  profileId: 'x', profileName: null, sessionState: null, contextTokens: null, unread: 0,
  ...over,
})

vi.mock('../src/lib/api', () => ({
  api: {
    conversations: {
      list: vi.fn(async () => ({
        conversations: [
          conv({ id: 'kt-chief', profileId: 'chief', profileName: 'Chief', unread: 2, sessionState: 'resumable' }),
          conv({ id: 'k-default', profileId: 'k-secretary', profileName: 'K', title: 'Ship it', unread: 1 }),
          conv({ id: 'kt-lead-frontend', profileId: 'lead-frontend', profileName: 'Frontend', unread: 0 }),
        ],
      })),
      read: vi.fn(async () => ({ ok: true })),
      message: vi.fn(async () => ({ message: {}, threadId: 'kt-chief' })),
    },
    threads: {
      get: vi.fn(async () => ({
        thread: { id: 'kt-chief', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
        turns: [],
      })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
    },
    k: { ask: vi.fn(async () => ({})) },
  },
}))
import { api } from '../src/lib/api'
import { selectThread, getSelectedThread } from '../src/lib/thread-select'

function mount(conversationId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <MessagesPage conversationId={conversationId} />
    </QueryClientProvider>,
  )
  return { qc, ...utils }
}

describe('MessagesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectThread(null)
    window.location.hash = '' // row clicks/deletes navigate via the real route lib
    // clearAllMocks does NOT clear implementations — re-establish the default list
    // so a persistent per-test override (incl. the rejection test) can't bleed
    // into its neighbors.
    vi.mocked(api.conversations.list).mockResolvedValue({
      conversations: [
        conv({ id: 'kt-chief', profileId: 'chief', profileName: 'Chief', unread: 2, sessionState: 'resumable' }),
        conv({ id: 'k-default', profileId: 'k-secretary', profileName: 'K', title: 'Ship it', unread: 1 }),
        conv({ id: 'kt-lead-frontend', profileId: 'lead-frontend', profileName: 'Frontend', unread: 0 }),
      ],
    } as never)
  })
  afterEach(() => {
    cleanup()
    selectThread(null)
  })

  it('groups K threads FIRST, then agent conversations; unread badges shown; NULL titles fall back to the profile name', async () => {
    mount()
    await screen.findByText('Ship it')
    const rows = screen.getAllByTestId(/^messages-row-/)
    expect(rows[0].getAttribute('data-testid')).toBe('messages-row-k-default')
    expect(screen.getByTestId('messages-unread-kt-chief').textContent).toBe('2')
    expect(screen.queryByTestId('messages-unread-kt-lead-frontend')).toBeNull()
    expect(screen.getByText('Chief')).toBeTruthy() // profile-name fallback title
  })

  it('selecting a conversation marks it read and renders its ConversationView', async () => {
    mount()
    await screen.findByText('Ship it')
    fireEvent.click(screen.getByTestId('messages-row-kt-chief'))
    await waitFor(() => expect(vi.mocked(api.conversations.read)).toHaveBeenCalledWith('kt-chief'))
  })

  it('a conversationId prop (deep link #/messages/<id>) selects it on mount', async () => {
    mount('kt-chief')
    await waitFor(() => expect(vi.mocked(api.conversations.read)).toHaveBeenCalledWith('kt-chief'))
    expect(vi.mocked(api.threads.get)).toHaveBeenCalledWith('kt-chief')
  })

  it('a failed list fetch shows an inline error — NEVER the first-run empty state', async () => {
    vi.mocked(api.conversations.list).mockRejectedValue(new Error('core down'))
    mount()
    await screen.findByTestId('messages-error')
    expect(screen.queryByText('No conversations yet')).toBeNull()
  })

  it('NEW unread arriving while the conversation stays selected re-marks it read (no stuck badge)', async () => {
    const { qc } = mount('kt-chief')
    await waitFor(() => expect(vi.mocked(api.conversations.read)).toHaveBeenCalledTimes(1))

    // A report-back lands: the still-selected conversation now shows unread 3.
    vi.mocked(api.conversations.list).mockResolvedValue({
      conversations: [conv({ id: 'kt-chief', profileId: 'chief', profileName: 'Chief', unread: 3 })],
    } as never)
    await qc.invalidateQueries({ queryKey: ['conversations'] })

    await waitFor(() => expect(vi.mocked(api.conversations.read).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(vi.mocked(api.conversations.read)).toHaveBeenLastCalledWith('kt-chief')
  })

  it('a failed read POST does not poison the id — clicking the row retries', async () => {
    vi.mocked(api.conversations.read).mockRejectedValueOnce(new Error('flake'))
    mount('kt-chief')
    await waitFor(() => expect(vi.mocked(api.conversations.read)).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('messages-row-kt-chief'))
    await waitFor(() => expect(vi.mocked(api.conversations.read)).toHaveBeenCalledTimes(2))
  })

  it('a deep link to an id not in the list shows an honest not-found state (not the hero)', async () => {
    mount('kt-nope')
    expect(await screen.findByTestId('messages-not-found')).toBeTruthy()
    expect(vi.mocked(api.conversations.read)).not.toHaveBeenCalled()
  })

  // ── ChatsTab parity (retired chats-tab.test.tsx coverage) ──────────────────

  it('the archived toggle refetches the list with archived included', async () => {
    mount()
    await screen.findByText('Ship it')
    expect(vi.mocked(api.conversations.list)).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByTestId('messages-archived-toggle'))
    await waitFor(() => expect(vi.mocked(api.conversations.list)).toHaveBeenCalledWith(true))
  })

  it('K rows are managed (rename/archive/delete affordances); agent rows are not', async () => {
    mount()
    await screen.findByText('Ship it')
    expect(screen.getByTestId('messages-rename-k-default')).toBeTruthy()
    expect(screen.getByTestId('messages-archive-k-default')).toBeTruthy()
    expect(screen.getByTestId('messages-delete-k-default')).toBeTruthy()
    expect(screen.queryByTestId('messages-rename-kt-chief')).toBeNull()
    expect(screen.queryByTestId('messages-archive-kt-chief')).toBeNull()
    expect(screen.queryByTestId('messages-delete-kt-chief')).toBeNull()
  })

  it('rename: pencil -> inline input -> Enter calls api.threads.update(id, {title})', async () => {
    mount()
    await screen.findByText('Ship it')
    fireEvent.click(screen.getByTestId('messages-rename-k-default'))
    const input = screen.getByTestId('messages-rename-input-k-default') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(vi.mocked(api.threads.update)).toHaveBeenCalledWith('k-default', { title: 'New title' }))
  })

  it('archive toggles via api.threads.update; archiving the Home-selected K thread demotes the selection', async () => {
    vi.mocked(api.conversations.list).mockResolvedValue({
      conversations: [
        conv({ id: 'k-default', profileId: 'k-secretary', profileName: 'K', title: 'Ship it' }),
        conv({ id: 'k-other', profileId: 'k-secretary', profileName: 'K', title: 'Other chat' }),
      ],
    } as never)
    selectThread('k-default')
    mount()
    await screen.findByText('Ship it')

    fireEvent.click(screen.getByTestId('messages-archive-k-default'))

    await waitFor(() => expect(vi.mocked(api.threads.update)).toHaveBeenCalledWith('k-default', { archived: true }))
    await waitFor(() => expect(getSelectedThread()).toBe('k-other'))
  })

  it('unarchiving never touches the selection', async () => {
    vi.mocked(api.conversations.list).mockResolvedValue({
      conversations: [
        conv({ id: 'k-default', profileId: 'k-secretary', profileName: 'K', title: 'Ship it', archivedAt: Date.now() }),
      ],
    } as never)
    selectThread('k-default')
    mount()
    await screen.findByText('Ship it')

    fireEvent.click(screen.getByTestId('messages-archive-k-default'))

    await waitFor(() => expect(vi.mocked(api.threads.update)).toHaveBeenCalledWith('k-default', { archived: false }))
    expect(getSelectedThread()).toBe('k-default')
  })

  it('delete opens ConfirmDialog; confirm calls api.threads.remove; a 409 rejection surfaces in the dialog error', async () => {
    mount()
    await screen.findByText('Ship it')

    fireEvent.click(screen.getByTestId('messages-delete-k-default'))
    expect(await screen.findByTestId('messages-delete-confirm')).toBeTruthy()

    vi.mocked(api.threads.remove).mockRejectedValueOnce(new Error('thread has a live run'))
    fireEvent.click(screen.getByTestId('messages-delete-confirm-confirm'))

    await waitFor(() => expect(vi.mocked(api.threads.remove)).toHaveBeenCalledWith('k-default'))
    expect(await screen.findByTestId('messages-delete-confirm-error')).toBeTruthy()
    expect(screen.getByTestId('messages-delete-confirm-error').textContent).toContain('thread has a live run')

    // A retry that succeeds closes the dialog.
    fireEvent.click(screen.getByTestId('messages-delete-confirm-confirm'))
    await waitFor(() => expect(screen.queryByTestId('messages-delete-confirm')).toBeNull())
  })

  it('deleting the SELECTED conversation navigates back to #/messages (no dangling deep link)', async () => {
    mount('k-default')
    await screen.findByText('Ship it')

    fireEvent.click(screen.getByTestId('messages-delete-k-default'))
    fireEvent.click(await screen.findByTestId('messages-delete-confirm-confirm'))

    await waitFor(() => expect(vi.mocked(api.threads.remove)).toHaveBeenCalledWith('k-default'))
    await waitFor(() => expect(window.location.hash).toBe('#/messages'))
  })

  it('6+ conversations render a search input that filters the list by title', async () => {
    vi.mocked(api.conversations.list).mockResolvedValue({
      conversations: Array.from({ length: 6 }, (_, i) =>
        conv({ id: `kt-${i}`, profileId: `agent-${i}`, profileName: `Agent number ${i}` })),
    } as never)
    mount()
    const search = await screen.findByTestId('messages-search')
    await waitFor(() => expect(screen.getByTestId('messages-row-kt-0')).toBeTruthy())

    fireEvent.change(search, { target: { value: 'number 3' } })
    await waitFor(() => expect(screen.queryByTestId('messages-row-kt-0')).toBeNull())
    expect(screen.getByTestId('messages-row-kt-3')).toBeTruthy()

    // Zero matches: an honest note, not orphaned group headers over nothing.
    fireEvent.change(search, { target: { value: 'zzz-no-such' } })
    await waitFor(() => expect(screen.queryByTestId('messages-row-kt-3')).toBeNull())
    expect(screen.getByTestId('messages-no-matches')).toBeTruthy()
    expect(screen.queryByText('Agents')).toBeNull() // empty group header hidden
  })
})
