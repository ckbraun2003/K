/**
 * Sidebar collapse toggle (F-011): the expand/collapse toggle must stay in a
 * consistent position — the header, next to the logo — in BOTH states, instead of
 * relocating to mid-rail when collapsed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { runsRef } = vi.hoisted(() => ({ runsRef: { current: [] as import('@k/shared').Run[] } }))

vi.mock('../src/lib/runs-query', () => ({
  RUNS_LIST_KEY: ['runs', 'list', 'default'],
  runsListQueryFn: async () => runsRef.current,
  isActiveRun: (r: { status: string }) => r.status === 'running' || r.status === 'queued',
  isParkedRun: (r: { status: string }) => r.status === 'awaiting_input',
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import Sidebar from '../src/shell/Sidebar'
import type { Run } from '@k/shared'

afterEach(() => { cleanup(); runsRef.current = [] })

const makeRun = (over: Partial<Run>): Run => ({
  id: over.id ?? 'run-1', prompt: 'do a thing', cwd: '/repo', status: 'running',
  provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0, ...over,
})

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

describe('Sidebar runs badge — parked runs count (F-055)', () => {
  it('a parked (awaiting_input) run makes the badge non-zero', async () => {
    runsRef.current = [makeRun({ id: 'p', status: 'awaiting_input' })]
    renderSidebar(false)
    const badge = await screen.findByTestId('sidebar-runs-badge')
    expect(badge.textContent).toBe('1')
    // Amber attention styling + a title naming the awaiting-input run.
    expect(badge.className).toContain('text-[var(--amber)]')
    expect(badge.getAttribute('title')).toMatch(/awaiting your input/i)
  })

  it('counts active + parked together', async () => {
    runsRef.current = [
      makeRun({ id: 'a', status: 'running' }),
      makeRun({ id: 'p', status: 'awaiting_input' }),
    ]
    renderSidebar(false)
    const badge = await screen.findByTestId('sidebar-runs-badge')
    expect(badge.textContent).toBe('2')
  })
})
