import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Notification as KNotification } from '@k/shared'

// Task 8: the notification center is now portaled to document.body and reads
// glass-overlay + severity icons + a per-row "Mark read" dismiss affordance.
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

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

beforeEach(() => { mockList.mockReset() })
afterEach(() => cleanup())

function notif(over: Partial<KNotification> = {}): KNotification {
  return {
    id: 'n1', eventKey: 'run_failed', title: 'Run failed', body: 'The run errored out.',
    runId: 'r1', projectId: 'p1', createdAt: Date.now() - 1000, readAt: null,
    ...over,
  }
}

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><NotificationBell /></QueryClientProvider>)
}

describe('notification center (Task 8)', () => {
  it('the popover is portaled to document.body and reads glass-overlay', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1' })], unread: 1 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    const panel = await screen.findByTestId('notif-popover')
    expect(panel.className).toContain('glass-overlay')
    expect(panel.parentElement).toBe(document.body)
  })

  it('a run_failed-keyed notification renders the red warning severity icon', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1', eventKey: 'run_failed' })], unread: 1 })
    const { container } = renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    await screen.findByTestId('notif-row-n1')
    const icon = document.body.querySelector('[data-testid="notif-row-n1"] .text-red')
    expect(icon).toBeTruthy()
    // sanity: the render call's own container never holds the portaled markup.
    expect(container.querySelector('[data-testid="notif-popover"]')).toBeNull()
  })

  it('the per-row "Mark read" button marks it read without navigating', async () => {
    mockList.mockResolvedValue({ notifications: [notif({ id: 'n1', runId: 'r1', readAt: null })], unread: 1 })
    renderBell()
    fireEvent.click(screen.getByTestId('notif-bell'))
    await screen.findByTestId('notif-row-n1')
    fireEvent.click(screen.getByLabelText('Mark read'))
    await waitFor(() => expect(api.notifications.markRead).toHaveBeenCalledWith('n1'))
    expect(navigate).not.toHaveBeenCalled()
  })
})
