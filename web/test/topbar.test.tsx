/**
 * TopBar — titles + detail-view breadcrumbs (wave C1; DETAIL_PARENTS retargeted
 * to the 6-rail hubs in UI Simplification Task 10). The contract:
 *   - a Sidebar destination view renders its plain label (e.g. 'Runs')
 *   - a detail view ('orchestrator' / 'project') renders a "Parent › EntityName"
 *     breadcrumb: the parent segment navigates to the list view, and the entity
 *     name resolves from the SAME query key+fn the detail page owns (react-query
 *     dedupe — TopBar adds zero fetches elsewhere)
 *   - a parent-less detail view with no async entity name ('timeline') still
 *     names itself in the breadcrumb tail, via its own Sidebar destination label
 *   - an unknown view surfaces 'Not found' (never masquerades as Home)
 *   - the launcher pill is deleted (impressive-wave Q1); ⌘K chord → focusDock() is
 *     covered by shell-keys.test.tsx + Shell's useShellKeys binding
 * api + route.navigate + dock-bus.focusDock are mocked (vi.hoisted, mirroring
 * the sibling suites).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentProfile, ChiefOrgLead } from '@k/shared'

const { mockNavigate, mockFocusDock, mockOrchGet, mockWorkflowGet, mockProjectsList, KNOWN } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockFocusDock: vi.fn(),
  mockOrchGet: vi.fn(),
  mockWorkflowGet: vi.fn(),
  mockProjectsList: vi.fn(async () => []),
  // Inside vi.hoisted so the (hoisted) route mock factory below can reference it.
  KNOWN: new Set(['home', 'runs', 'orchestrator', 'agents', 'projects', 'project', 'timeline']),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    orchestrators: { get: mockOrchGet },
    workflows: { get: mockWorkflowGet },
    projects: { list: mockProjectsList },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: KNOWN,
  isKnownView: (v: string) => KNOWN.has(v),
  useHashRoute: () => ({ view: 'home' }),
}))

vi.mock('../src/lib/dock-bus', () => ({ focusDock: mockFocusDock }))

import TopBar from '../src/shell/TopBar'

// Minimal ChiefOrgLead detail fixture (shape mirrors orchestrators.test.ts helpers).
function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'lead-frontend',
    name: 'Frontend',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: 'claude-sonnet-4-6',
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...over,
  }
}
function detail(over: Partial<ChiefOrgLead> = {}): ChiefOrgLead {
  return { profile: profile(), latestRun: null, events: [], wakes: [], ...over }
}

function renderBar(view: string, param?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TopBar view={view} param={param} connected />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockNavigate.mockClear()
  mockFocusDock.mockClear()
  mockOrchGet.mockReset()
  mockOrchGet.mockResolvedValue(detail())
})
afterEach(() => cleanup())

describe('TopBar', () => {
  it('renders the plain destination label for a Sidebar view', () => {
    renderBar('runs')
    expect(screen.getByTestId('topbar-title').textContent).toContain('Runs')
    expect(screen.queryByTestId('topbar-parent')).toBeNull()
  })

  it('renders the Agents › <lead name> breadcrumb and navigates via the parent segment', async () => {
    renderBar('orchestrator', 'lead-frontend')

    // Parent label renders immediately (no dangling '›' before the name resolves)…
    const parent = screen.getByTestId('topbar-parent')
    expect(parent.textContent).toBe('Agents')

    // …then the lead name resolves from the shared ['orchestrator', id] query.
    expect(await screen.findByText('Frontend')).toBeTruthy()
    expect(screen.getByTestId('topbar-title').textContent).toContain('›')

    fireEvent.click(parent)
    expect(mockNavigate).toHaveBeenCalledWith('agents')
  })

  it('renders the Projects breadcrumb for a project detail view and navigates via the parent segment', () => {
    renderBar('project', 'p1')
    const parent = screen.getByTestId('topbar-parent')
    expect(parent.textContent).toBe('Projects')
    fireEvent.click(parent)
    expect(mockNavigate).toHaveBeenCalledWith('projects')
  })

  it('a parent-less detail view (timeline) names itself in the breadcrumb tail', () => {
    renderBar('timeline')
    const parent = screen.getByTestId('topbar-parent')
    expect(parent.textContent).toBe('K')
    expect(screen.getByTestId('topbar-title').textContent).toContain('Timeline')
    fireEvent.click(parent)
    expect(mockNavigate).toHaveBeenCalledWith('home')
  })

  it('surfaces Not found for an unknown view (never masquerades as Home)', () => {
    renderBar('nonsense')
    expect(screen.getByTestId('topbar-title').textContent).toContain('Not found')
  })

  it('has no dock-launcher pill — ⌘K/dock focus lives in the chord path (shell-keys.test) and the dock itself', () => {
    renderBar('home')
    expect(screen.queryByTestId('topbar-dock-launcher')).toBeNull()
    expect(mockFocusDock).not.toHaveBeenCalled()
  })
})
