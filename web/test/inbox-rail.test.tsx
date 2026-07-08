/** P2 W0d — Inbox rail destination + needs-YOU badge (the ONE sanctioned new rail slot). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockInbox, mockRuns } = vi.hoisted(() => ({ mockInbox: vi.fn(), mockRuns: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: {
    inbox: { list: mockInbox },
    runs: { list: mockRuns },
  },
}))
import Sidebar from '../src/shell/Sidebar'

beforeEach(() => {
  mockRuns.mockResolvedValue([])
  mockInbox.mockResolvedValue({
    items: [], counts: { plan_pending: 2, input_needed: 1, lesson_pending: 0, mcp_trust: 0, review_ready: 0 }, total: 3,
  })
})
afterEach(() => cleanup())

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Sidebar active="home" collapsed={false} onToggleCollapse={() => {}} />
    </QueryClientProvider>,
  )
}

describe('Inbox rail entry', () => {
  it('renders the destination and the needs-YOU badge count', async () => {
    renderSidebar()
    expect(await screen.findByRole('button', { name: /Inbox/ })).toBeTruthy()
    expect((await screen.findByTestId('sidebar-inbox-badge')).textContent).toBe('3')
  })
})
