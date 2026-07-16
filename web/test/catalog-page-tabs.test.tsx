/**
 * CatalogPage (orchestration-p2 Task B.4, renamed from SkillsPage) — the Catalog
 * destination under the Agents hub. Locks: deep links render the right tab,
 * no/unknown param defaults to the Skills tab, the CapabilityStatRow renders on
 * EVERY tab with honest summary figures, and tab clicks navigate (hash-routed,
 * not local state).
 *
 * The old 4th "Automations" sub-tab (the pre-catalog skill/hook/workflow-with-
 * triggers registry) is RETIRED from Catalog by the orchestration-p2 IA redesign
 * (design §2.3: "their routes redirect into Automations") — it is not re-tested
 * here; its standalone component still has its own dedicated test files
 * (skills-history-empty/e11-sweep/routines-ui.test.tsx import it directly).
 * A 4th "Sub Agents" tab is added on top of this file by Task B.5.
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
  mockSkillsList, mockProjectsList, mockNavigate, mockRoutinesList, mockParseCron,
} = vi.hoisted(() => ({
  mockCatalogSkills: vi.fn(),
  mockCatalogMcp: vi.fn(),
  mockCatalogHooks: vi.fn(),
  mockSummary: vi.fn(),
  mockSkillsList: vi.fn(),
  mockProjectsList: vi.fn(),
  mockNavigate: vi.fn(),
  mockRoutinesList: vi.fn(),
  mockParseCron: vi.fn(),
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
    routines: { list: mockRoutinesList, parseCron: mockParseCron },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import CatalogPage from '../src/pages/CatalogPage'

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
      <CatalogPage tab={tab} />
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
  mockRoutinesList.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('CatalogPage — routed tabs', () => {
  it('defaults to the Skills tab with no param', async () => {
    renderPage(undefined)
    expect(screen.getByTestId('tab-skills').getAttribute('aria-selected')).toBe('true')
    await screen.findByText(/Capability catalog/)
  })

  it('an unknown param also lands on the Skills tab (no dead route)', () => {
    renderPage('nonsense')
    expect(screen.getByTestId('tab-skills').getAttribute('aria-selected')).toBe('true')
  })

  it('deep link #/agents/catalog/mcp renders the MCP tab', async () => {
    renderPage('mcp')
    expect(screen.getByTestId('tab-mcp').getAttribute('aria-selected')).toBe('true')
    await screen.findByText(/MCP servers ·/)
  })

  it('deep link #/agents/catalog/hooks renders the read-only hooks view + scope banner', async () => {
    renderPage('hooks')
    expect(screen.getByTestId('tab-hooks').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('hooks-info-banner').textContent).toContain(
      'K never executes host hooks',
    )
  })

  it('clicking a tab NAVIGATES (hash-routed), rather than flipping local state', () => {
    renderPage(undefined)
    fireEvent.click(screen.getByTestId('tab-mcp'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'catalog', 'mcp')
    fireEvent.click(screen.getByTestId('tab-skills'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'catalog', undefined)
  })

  it('exposes the tablist pattern (roles)', () => {
    renderPage(undefined)
    // The canonical Tabs (E-30) exposes the tablist/tab roles but intentionally
    // emits no aria-controls (it renders no element id to point at).
    expect(screen.getByRole('tablist')).toBeTruthy()
    const tab = screen.getByTestId('tab-mcp')
    expect(tab.getAttribute('role')).toBe('tab')
  })
})

describe('CatalogPage — CapabilityStatRow on every tab', () => {
  it.each([undefined, 'mcp', 'hooks'] as const)(
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
    expect(row.textContent).toContain('Total context weight:')
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
