/**
 * Sidebar collapse toggle (F-011): the expand/collapse toggle must stay in a
 * consistent position — the header, next to the logo — in BOTH states, instead of
 * relocating to mid-rail when collapsed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/runs-query', () => ({
  RUNS_LIST_KEY: ['runs', 'list', 'default'],
  runsListQueryFn: async () => [],
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import Sidebar from '../src/shell/Sidebar'

afterEach(() => cleanup())

function renderSidebar(collapsed: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Sidebar active="home" collapsed={collapsed} onToggleCollapse={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** The header is the element that also holds the ⚡ logo (title="K"). */
function toggleSharesHeaderWithLogo(toggle: HTMLElement): boolean {
  return toggle.parentElement?.querySelector('[title="K"]') != null
}

describe('Sidebar collapse toggle position', () => {
  it('expanded: the collapse toggle sits in the header beside the logo', () => {
    renderSidebar(false)
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(toggleSharesHeaderWithLogo(toggle)).toBe(true)
  })

  it('collapsed: the expand toggle stays in the same header (not mid-rail)', () => {
    renderSidebar(true)
    const toggle = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(toggleSharesHeaderWithLogo(toggle)).toBe(true)
    // exactly one toggle rendered (no duplicate mid-rail button)
    expect(screen.queryAllByRole('button', { name: /(Expand|Collapse) sidebar/ })).toHaveLength(1)
  })
})
