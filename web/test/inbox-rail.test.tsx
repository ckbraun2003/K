/** UI Simplification Task 10 — the inbox needs-YOU badge moved from its own rail
 *  slot onto the merged `personal` destination (Personal hub owns the inbox now). */
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

describe('Personal rail entry (inbox badge)', () => {
  it('renders the Personal destination and the needs-YOU badge count', async () => {
    renderSidebar()
    expect(await screen.findByRole('button', { name: /Personal/ })).toBeTruthy()
    expect((await screen.findByTestId('sidebar-personal-badge')).textContent).toBe('3')
  })

  it('there is no standalone Inbox rail entry any more', () => {
    renderSidebar()
    expect(screen.queryByRole('button', { name: /^Inbox$/ })).toBeNull()
  })
})
