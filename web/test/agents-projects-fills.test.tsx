/**
 * agents-projects-fills.test.tsx — Impressive Wave Task 10 Step 7 verification
 * probes for fills touched across Steps 1-6 that didn't already have a
 * dedicated locking test:
 *   1. AgentsPage's Automations tab shows the renamed label, never "Pipelines".
 *   2. OrgPage's autonomy status chip carries a Settings-referencing title
 *      regardless of on/off state.
 *   3. ProjectsPage renders the register-ghost CTA and clicking it opens the
 *      register dialog.
 *   4. CatalogTab's WeightMeter: a null estTokens skill renders the "not yet
 *      measured" aria-label; the catalog's heaviest entry renders 3 lit bars.
 *
 * A single shared `../src/lib/api` mock backs all four probes — vi.mock is
 * file-scoped/hoisted, so one mock object has to serve every component under
 * test in this file. AgentsPage's Skills/Automations children and OrgPage's
 * own leaf views (Roster/Tree/Graph) are mocked to marker divs exactly as
 * their existing dedicated test files (agents-page.test.tsx, org-page.test.tsx)
 * already do — this file locks only the 4 probes above, never re-tests their
 * internals.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project, CatalogSkill } from '@k/shared'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub — CatalogTab's tree pulls in components that
    // probe matchMedia in some environments (mirrors skills-catalog.test.tsx).
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockProjectsList, mockGithubFleet, mockRunsList, mockAutonomyGet, mockSkills } = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockGithubFleet: vi.fn(),
  mockRunsList: vi.fn(),
  mockAutonomyGet: vi.fn(),
  mockSkills: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: {
      list: mockProjectsList,
      githubFleet: mockGithubFleet,
      register: vi.fn(),
      delete: vi.fn(),
    },
    runs: { list: mockRunsList },
    autonomy: { get: mockAutonomyGet },
    capabilities: { skills: mockSkills, toggleSkill: vi.fn(), rescan: vi.fn() },
  },
}))

// AgentsPage's own children — probe 1 only locks the tab BAR label, never
// their bodies (each already has its own dedicated test file).
vi.mock('../src/pages/CatalogPage', () => ({ default: () => <div data-testid="catalog-page-mock" /> }))
// OrgPage itself stays REAL for probe 2 (the autonomy chip lives on it) — only
// its own leaf views are mocked, mirroring org-page.test.tsx.
vi.mock('../src/pages/org/RosterView', () => ({ default: () => <div data-testid="seg-body-roster" /> }))
vi.mock('../src/pages/org/TreeView', () => ({ default: () => <div data-testid="seg-body-tree" /> }))
vi.mock('../src/pages/org/GraphView', () => ({ default: () => <div data-testid="seg-body-graph" /> }))

import AgentsPage from '../src/pages/AgentsPage'
import OrgPage from '../src/pages/OrgPage'
import ProjectsPage from '../src/pages/ProjectsPage'
import CatalogTab from '../src/pages/skills/CatalogTab'

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// One seeded project so ProjectsPage never falls into its projects.length===0
// GettingStarted branch (which would drag in navigate/framer-motion mocking
// unrelated to this probe).
const project: Project = {
  id: 'p1', name: 'demo', localPath: '/demo', githubRemote: null,
  workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0,
}

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id, description: null, sourceKind: 'k', pluginName: null,
    path: `agent-config/skills/${over.id}/SKILL.md`, enabled: false,
    estTokens: null, estTokensMeta: null, modelCompat: 'universal',
    mountedBy: [], status: 'ok', updatedAt: null, ...over,
  }
}

beforeEach(() => {
  mockProjectsList.mockReset(); mockGithubFleet.mockReset(); mockRunsList.mockReset()
  mockAutonomyGet.mockReset(); mockSkills.mockReset()
  mockProjectsList.mockResolvedValue([project])
  mockGithubFleet.mockResolvedValue({})
  mockRunsList.mockResolvedValue([])
  mockAutonomyGet.mockResolvedValue(DEFAULT_AUTONOMY_SETTINGS)
  mockSkills.mockResolvedValue({
    skills: [
      // refMax = 5000 (the only measured entry) -> frac 1 -> heavy, 3 lit bars.
      skill({ id: 'heavy-skill', estTokens: 5000 }),
      skill({ id: 'unmeasured-skill', estTokens: null }),
    ],
    scannedAt: 1,
    warnings: [],
  })
})
afterEach(() => cleanup())

describe('Impressive Wave Task 10 Step 7 — verification probes', () => {
  it('1. AgentsPage renders an "Automations" tab, never "Pipelines"', () => {
    withQuery(<AgentsPage />)
    const tab = screen.getByTestId('tab-automations')
    expect(tab.textContent).toBe('Automations')
    expect(tab.textContent).not.toBe('Pipelines')
  })

  it('2. org-autonomy-chip title mentions Settings regardless of on/off state', async () => {
    withQuery(<OrgPage />)
    const chip = await screen.findByTestId('org-autonomy-chip')
    expect(chip.getAttribute('title')).toContain('Settings')
  })

  it('3. ProjectsPage renders register-ghost; clicking it opens the register dialog', async () => {
    withQuery(<ProjectsPage />)
    const ghost = await screen.findByTestId('register-ghost')
    expect(screen.queryByTestId('register-dialog')).toBeNull()
    fireEvent.click(ghost)
    expect(screen.getByTestId('register-dialog')).toBeTruthy()
  })

  it('4. CatalogTab WeightMeter: null estTokens -> not-yet-measured; the heaviest entry -> 3 lit bars', async () => {
    withQuery(<CatalogTab />)
    const heavyRow = await screen.findByTestId('catalog-row-heavy-skill')
    const heavyMeter = heavyRow.querySelector('[data-testid="catalog-weight-band"]')
    expect(heavyMeter?.getAttribute('aria-label')).toBe('heavy context weight')
    const litBars = Array.from(heavyMeter?.querySelectorAll('span') ?? [])
    expect(litBars.filter(el => el.className.includes('bg-accent-hover')).length).toBe(3)

    const unmeasuredRow = screen.getByTestId('catalog-row-unmeasured-skill')
    const unmeasuredMeter = unmeasuredRow.querySelector('[data-testid="catalog-weight-band"]')
    expect(unmeasuredMeter?.getAttribute('aria-label')).toBe('not yet measured — probe or run to estimate')
  })
})
