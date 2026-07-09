import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Notification as KNotification } from '@k/shared'

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    notifications: {
      list: mockList,
      markRead: vi.fn(async () => {}),
      markAllRead: vi.fn(async () => ({ marked: 0 })),
    },
  },
}))

vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import { api } from '../src/lib/api'
import { navigate } from '../src/lib/route'
import NotificationBell from '../src/components/NotificationBell'

// jsdom has no matchMedia; provide an inert stub for any framer-motion probing.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough
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

function notif(over: Partial<KNotification> = {}): KNotification {
  return {
    id: 'n1',
    eventKey: 'run_failed',
    title: 'Run failed',
    body: 'The run errored out.',
    runId: 'r1',
    projectId: 'p1',
    createdAt: Date.now() - 1000,
    readAt: null,
    ...over,
  }
}

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <NotificationBell />
    </QueryClientProvider>,
  )
}

describe('NotificationBell', () => {
  it('renders the bell with an unread dot when there are unread notifications', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1' }), notif({ id: 'n2' })], unread: 2 })
    renderBell()
    expect(screen.getByTestId('notif-bell')).toBeTruthy()
    expect(await screen.findByTestId('notif-unread-dot')).toBeTruthy()
  })

  it('opens the popover listing the notification rows', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1' })], unread: 1 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    expect(screen.getByTestId('notif-popover')).toBeTruthy()
    expect(await screen.findByTestId('notif-row-n1')).toBeTruthy()
  })

  it('clicking a row marks it read (and navigates when it carries a runId)', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1', runId: 'r1' })], unread: 1 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    fireEvent.click(await screen.findByTestId('notif-row-n1'))
    await waitFor(() => expect(api.notifications.markRead).toHaveBeenCalledWith('n1'))
    expect(navigate).toHaveBeenCalledWith('runs', 'r1')
  })

  it('Mark all read calls api.notifications.markAllRead', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1' })], unread: 1 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    // Wait for the query to resolve (rows present) — Mark all read is disabled while
    // the list is empty/loading, so click it only once there is something to mark.
    await screen.findByTestId('notif-row-n1')
    fireEvent.click(screen.getByTestId('notif-mark-all'))
    await waitFor(() => expect(api.notifications.markAllRead).toHaveBeenCalled())
  })

  it('renders no unread dot when unread is 0', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1', readAt: Date.now() })], unread: 0 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    // Wait for the query to resolve (the read row appears) before asserting absence.
    await screen.findByTestId('notif-row-n1')
    expect(screen.queryByTestId('notif-unread-dot')).toBeNull()
  })
})
