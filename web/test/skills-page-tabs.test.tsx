/**
 * SkillsPage (wave C2) — the four-tab Skills destination. Locks: deep links
 * render the right tab, no/unknown param defaults to the Catalog, the
 * CapabilityStatRow renders on EVERY tab with honest summary figures, tab
 * clicks navigate (hash-routed, not local state), and the extracted
 * AutomationsTab still presents the pre-catalog affordances (regression lock).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CapabilitySummary } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const {
  mockCatalogSkills, mockCatalogMcp, mockCatalogHooks, mockSummary,
  mockSkillsList, mockProjectsList, mockNavigate,
} = vi.hoisted(() => ({
  mockCatalogSkills: vi.fn(),
  mockCatalogMcp: vi.fn(),
  mockCatalogHooks: vi.fn(),
  mockSummary: vi.fn(),
  mockSkillsList: vi.fn(),
  mockProjectsList: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    capabilities: {
      skills: mockCatalogSkills,
      mcp: mockCatalogMcp,
      hooks: mockCatalogHooks,
      summary: mockSummary,
      rescan: vi.fn(),
      toggleSkill: vi.fn(),
      toggleMcp: vi.fn(),
      trustMcp: vi.fn(),
      probeMcp: vi.fn(),
    },
    skills: { list: mockSkillsList, evals: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]) },
    projects: { list: mockProjectsList },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import SkillsPage from '../src/pages/SkillsPage'

const summary: CapabilitySummary = {
  skills: { enabledCount: 3, estTokens: 12_000, unestimatedCount: 1 },
  mcp: { enabledCount: 2, estTokens: 6_200, unestimatedCount: 0 },
  totalEstTokens: 18_200,
  perSource: {
    'k': { skills: 2, mcpServers: 1 },
    'claude-user': { skills: 1, mcpServers: 1 },
    'claude-project': { skills: 0, mcpServers: 0 },
    'claude-plugin': { skills: 0, mcpServers: 0 },
  },
  scannedAt: 1,
}

function renderPage(tab?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SkillsPage tab={tab} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCatalogSkills.mockResolvedValue({ skills: [], scannedAt: null, warnings: [] })
  mockCatalogMcp.mockResolvedValue({ servers: [], scannedAt: null, warnings: [] })
  mockCatalogHooks.mockResolvedValue({ hooks: [], scannedAt: null, warnings: [] })
  mockSummary.mockResolvedValue(summary)
  mockSkillsList.mockResolvedValue([])
  mockProjectsList.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('SkillsPage — routed tabs', () => {
  it('defaults to the Catalog tab with no param', async () => {
    renderPage(undefined)
    expect(screen.getByTestId('skills-tab-catalog').getAttribute('aria-selected')).toBe('true')
    await screen.findByText(/Capability catalog/)
  })

  it('an unknown param also lands on the Catalog (no dead route)', () => {
    renderPage('nonsense')
    expect(screen.getByTestId('skills-tab-catalog').getAttribute('aria-selected')).toBe('true')
  })

  it('deep link #/skills/mcp renders the MCP tab', async () => {
    renderPage('mcp')
    expect(screen.getByTestId('skills-tab-mcp').getAttribute('aria-selected')).toBe('true')
    await screen.findByText(/MCP servers ·/)
  })

  it('deep link #/skills/hooks renders the read-only hooks view + scope banner', async () => {
    renderPage('hooks')
    expect(screen.getByTestId('skills-tab-hooks').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('hooks-info-banner').textContent).toContain(
      'K never executes host hooks',
    )
  })

  it('deep link #/skills/automations renders the extracted automation registry', async () => {
    renderPage('automations')
    expect(screen.getByTestId('skills-tab-automations').getAttribute('aria-selected')).toBe('true')
    // Regression-locked affordances from the pre-catalog SkillsPage body:
    await screen.findByText(/Skills · 0 registered/)
    expect(screen.getByText('+ add skill')).toBeTruthy()
  })

  it('clicking a tab NAVIGATES (hash-routed), rather than flipping local state', () => {
    renderPage(undefined)
    fireEvent.click(screen.getByTestId('skills-tab-mcp'))
    expect(mockNavigate).toHaveBeenCalledWith('skills', 'mcp')
    fireEvent.click(screen.getByTestId('skills-tab-catalog'))
    expect(mockNavigate).toHaveBeenCalledWith('skills', undefined)
  })

  it('exposes the tablist pattern (roles + aria-controls)', () => {
    renderPage(undefined)
    expect(screen.getByRole('tablist')).toBeTruthy()
    const tab = screen.getByTestId('skills-tab-mcp')
    expect(tab.getAttribute('role')).toBe('tab')
    expect(tab.getAttribute('aria-controls')).toBe('tabpanel-mcp')
  })
})

describe('SkillsPage — CapabilityStatRow on every tab', () => {
  it.each([undefined, 'mcp', 'hooks', 'automations'] as const)(
    'renders the stat strip on tab param %s',
    async tabParam => {
      renderPage(tabParam)
      const row = await screen.findByTestId('capability-stat-row')
      expect(row).toBeTruthy()
    },
  )

  it('shows the summary figures with compact-formatted token estimates', async () => {
    renderPage(undefined)
    const row = await screen.findByTestId('capability-stat-row')
    // waits for the summary read to land (loading state shows em-dashes)
    await screen.findByTestId('capability-stat-unestimated')
    expect(row.textContent).toContain('Enabled skills:')
    expect(row.textContent).toContain('3')
    expect(row.textContent).toContain('~12.0k tok')
    expect(row.textContent).toContain('2 servers')
    expect(row.textContent).toContain('~6.2k tok')
    expect(row.textContent).toContain('Total context overhead:')
    expect(row.textContent).toContain('~18.2k tok')
    // 1 skill has no estimate — footnoted, never silently summed
    expect(row.textContent).toContain('1 not yet measured')
    // tooltip is honest about what the figures are
    expect(row.getAttribute('title')).toContain('not billed tokens')
  })

  it('never fakes a zero while the summary is loading', () => {
    mockSummary.mockReturnValue(new Promise(() => {}))
    renderPage(undefined)
    expect(screen.getByTestId('capability-stat-row').textContent).toContain('—')
  })
})
