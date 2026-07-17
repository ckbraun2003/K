/**
 * ChatView glass surfaces (usability-access B.2) — the home chat rail +
 * transcript containers move from `surface-solid` to `glass-panel` (the
 * composer input container is explicitly OUT of scope — no nested blur,
 * its parent dock bar is already glass-chrome). Locks the two containers via
 * stable `data-testid`s rather than DOM traversal from unrelated text, so a
 * future copy change can't silently break this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockThreadsList } = vi.hoisted(() => ({ mockThreadsList: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      list: mockThreadsList,
      get: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
  },
}))

import ChatView from '../src/pages/home/ChatView'

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChatView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockThreadsList.mockReset()
  mockThreadsList.mockResolvedValue({ threads: [] })
})
afterEach(() => cleanup())

describe('ChatView glass surfaces (B.2)', () => {
  it('the thread rail carries glass-panel (not surface-solid)', async () => {
    renderChat()
    const rail = await waitFor(() => screen.getByTestId('chat-thread-rail'))
    expect(rail.className).toContain('glass-panel')
    expect(rail.className).not.toContain('surface-solid')
    expect(rail.className).toContain('rounded-panel')
  })

  it('the transcript carries glass-panel (not surface-solid)', async () => {
    renderChat()
    const transcript = await waitFor(() => screen.getByTestId('chat-transcript'))
    expect(transcript.className).toContain('glass-panel')
    expect(transcript.className).not.toContain('surface-solid')
    expect(transcript.className).toContain('rounded-panel')
  })
})
