/**
 * AgentsPage IA (orchestration-p2 Task B.4) — replaces agents-page.test.tsx.
 * The Agents hub now has three top tabs: Org / Catalog / Automations
 * (was Org / Skills / Pipelines — Catalog absorbs the old capability
 * surfaces + the new Sub Agents registry; Automations absorbs the old
 * Pipelines tab + the retired workflow-skills registry). Locks:
 *   - the tab bar renders all 3 tabs (org/catalog/automations)
 *   - the `tab` prop selects the matching tab (an unknown value falls back to org)
 *   - the `sub` prop threads through to the active child as its own seg/tab/defId prop
 *   - clicking a tab navigates to agents/<tab>
 *   - the default tab (no `tab` prop) is org
 *   - every old deep-link (top-level legacy hashes + the renamed agents sub-params)
 *     resolves to the new canonical route via `resolveRoute`
 * The children (OrgPage/CatalogPage/AutomationsView) are mocked to marker divs — this
 * file locks AgentsPage's OWN routing/mounting logic; each child owns its own tests
 * (org-page.test.tsx, catalog-page-tabs.test.tsx, workflows-defs.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('../src/lib/route', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/route')>('../src/lib/route')
  return { ...actual, navigate: mockNavigate }
})
vi.mock('../src/pages/OrgPage', () => ({
  default: (p: { seg?: string }) => <div data-testid="org-page-mock">seg:{p.seg ?? 'none'}</div>,
}))
vi.mock('../src/pages/CatalogPage', () => ({
  default: (p: { tab?: string }) => <div data-testid="catalog-page-mock">tab:{p.tab ?? 'none'}</div>,
}))
vi.mock('../src/pages/runs/AutomationsView', () => ({
  default: (p: { defId?: string }) => <div data-testid="automations-view-mock">defId:{p.defId ?? 'none'}</div>,
}))

import AgentsPage from '../src/pages/AgentsPage'
import { resolveRoute } from '../src/lib/route'

beforeEach(() => mockNavigate.mockClear())
afterEach(() => cleanup())

describe('AgentsPage — Org / Catalog / Automations', () => {
  it('renders all 3 tabs', () => {
    render(<AgentsPage />)
    expect(screen.getByTestId('tab-org')).toBeTruthy()
    expect(screen.getByTestId('tab-catalog')).toBeTruthy()
    expect(screen.getByTestId('tab-automations')).toBeTruthy()
  })

  it('defaults to the org tab and mounts OrgPage', () => {
    render(<AgentsPage />)
    expect(screen.getByTestId('tab-org').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('org-page-mock')).toBeTruthy()
  })

  it('an unknown tab param falls back to org', () => {
    render(<AgentsPage tab="bogus" />)
    expect(screen.getByTestId('tab-org').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('org-page-mock')).toBeTruthy()
  })

  it('tab=org threads sub through as OrgPage seg prop', () => {
    render(<AgentsPage tab="org" sub="tree" />)
    expect(screen.getByTestId('org-page-mock').textContent).toBe('seg:tree')
  })

  it('tab=catalog mounts CatalogPage with sub threaded as its tab prop', () => {
    render(<AgentsPage tab="catalog" sub="mcp" />)
    expect(screen.getByTestId('tab-catalog').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('catalog-page-mock').textContent).toBe('tab:mcp')
    expect(screen.queryByTestId('org-page-mock')).toBeNull()
  })

  it('tab=automations with a sub mounts AutomationsView (legacy def deep-link) with sub as its defId prop', () => {
    render(<AgentsPage tab="automations" sub="def-1" />)
    expect(screen.getByTestId('tab-automations').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('automations-view-mock').textContent).toBe('defId:def-1')
    expect(screen.queryByTestId('org-page-mock')).toBeNull()
  })

  it('clicking a tab navigates hash-routed rather than flipping local state', () => {
    render(<AgentsPage />)
    fireEvent.click(screen.getByTestId('tab-catalog'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'catalog')
    fireEvent.click(screen.getByTestId('tab-automations'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'automations')
    fireEvent.click(screen.getByTestId('tab-org'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'org')
  })
})

describe('AgentsPage IA — legacy deep-link redirects (resolveRoute)', () => {
  it('bare legacy #/skills → agents/catalog', () => {
    expect(resolveRoute({ view: 'skills', param: 'mcp' })).toEqual({
      view: 'agents', param: 'catalog', subParam: 'mcp',
    })
  })

  it('bare legacy #/skills (no param) → agents/catalog (no sub)', () => {
    expect(resolveRoute({ view: 'skills', param: undefined })).toEqual({
      view: 'agents', param: 'catalog', subParam: undefined,
    })
  })

  it('bare legacy #/skills/automations → agents/automations (retired registry redirects up, not into a Catalog sub-tab)', () => {
    expect(resolveRoute({ view: 'skills', param: 'automations' })).toEqual({
      view: 'agents', param: 'automations',
    })
  })

  it('#/agents/skills/* → #/agents/catalog/* (renamed tab value)', () => {
    expect(resolveRoute({ view: 'agents', param: 'skills', subParam: 'hooks' })).toEqual({
      view: 'agents', param: 'catalog', subParam: 'hooks',
    })
  })

  it('#/agents/skills/automations → #/agents/automations (retired Catalog sub-tab redirects to the top-level tab)', () => {
    expect(resolveRoute({ view: 'agents', param: 'skills', subParam: 'automations' })).toEqual({
      view: 'agents', param: 'automations',
    })
  })

  it('#/agents/pipelines/* → #/agents/automations/* (renamed tab value, sub-param preserved)', () => {
    expect(resolveRoute({ view: 'agents', param: 'pipelines', subParam: 'def-9' })).toEqual({
      view: 'agents', param: 'automations', subParam: 'def-9',
    })
  })

  it('#/workflows/:id and #/workflow-detail/:id → #/agents/automations/:id', () => {
    expect(resolveRoute({ view: 'workflows', param: 'def-1' })).toEqual({
      view: 'agents', param: 'automations', subParam: 'def-1',
    })
    expect(resolveRoute({ view: 'workflow-detail', param: 'def-2' })).toEqual({
      view: 'agents', param: 'automations', subParam: 'def-2',
    })
  })

  it('#/runs/workflows/:id → #/agents/automations/:id', () => {
    expect(resolveRoute({ view: 'runs', param: 'workflows', subParam: 'def-3' })).toEqual({
      view: 'agents', param: 'automations', subParam: 'def-3',
    })
  })

  it('an already-canonical agents route passes through unchanged (idempotent, no redirect loop)', () => {
    expect(resolveRoute({ view: 'agents', param: 'catalog', subParam: 'mcp' })).toEqual({
      view: 'agents', param: 'catalog', subParam: 'mcp',
    })
    expect(resolveRoute({ view: 'agents', param: 'automations', subParam: 'def-1' })).toEqual({
      view: 'agents', param: 'automations', subParam: 'def-1',
    })
    expect(resolveRoute({ view: 'agents', param: 'org', subParam: 'tree' })).toEqual({
      view: 'agents', param: 'org', subParam: 'tree',
    })
  })
})
