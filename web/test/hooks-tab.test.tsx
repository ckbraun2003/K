/**
 * HooksTab (wave C2) — read-only host-hook visibility. Locks: the permanent
 * never-executed-by-K banner, per-row event/matcher/command rendering with
 * provenance, and that NO enable affordance exists (scope decision: K runs
 * execute only K's vendored hooks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogHook } from '@k/shared'

const { mockHooks } = vi.hoisted(() => ({ mockHooks: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: { capabilities: { hooks: mockHooks } },
}))

import HooksTab from '../src/pages/skills/HooksTab'

const hooks: CatalogHook[] = [
  {
    id: 'user:PostToolUse:0',
    sourceKind: 'claude-user',
    pluginName: null,
    event: 'PostToolUse',
    matcher: 'Bash(git commit*)',
    commandSummary: 'node scripts/reanalyze.mjs',
  },
  {
    id: 'plugin:ecc@x:Stop:0',
    sourceKind: 'claude-plugin',
    pluginName: 'everything-claude-code',
    event: 'Stop',
    matcher: null,
    commandSummary: 'npx ecc-stop-hook',
  },
]

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HooksTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHooks.mockResolvedValue({ hooks, scannedAt: 1, warnings: [] })
})
afterEach(() => cleanup())

describe('HooksTab', () => {
  it('always shows the visibility-only banner with the exact scope statement', async () => {
    renderTab()
    const banner = screen.getByTestId('hooks-info-banner')
    expect(banner.textContent).toContain('Listed for visibility only')
    expect(banner.textContent).toContain('K never executes host hooks inside managed runs')
    expect(banner.textContent).toContain("K's own gitnexus hook is the only hook the synthesizer mounts")
  })

  it('renders event, matcher, command and provenance per row', async () => {
    renderTab()
    const row = await screen.findByTestId('hook-row-user:PostToolUse:0')
    expect(row.textContent).toContain('PostToolUse')
    expect(row.textContent).toContain('matcher: Bash(git commit*)')
    expect(row.textContent).toContain('node scripts/reanalyze.mjs')
    // plugin hook names its plugin
    const pluginRow = screen.getByTestId('hook-row-plugin:ecc@x:Stop:0')
    expect(pluginRow.textContent).toContain('everything-claude-code')
  })

  it('offers NO enable affordance — hooks are visibility, not capability', async () => {
    renderTab()
    await screen.findByTestId('hook-row-user:PostToolUse:0')
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('an empty host renders the empty state', async () => {
    mockHooks.mockResolvedValue({ hooks: [], scannedAt: null, warnings: [] })
    renderTab()
    const empty = await screen.findByTestId('hooks-empty')
    expect(empty.textContent).toContain('No hooks found on the host.')
  })
})
