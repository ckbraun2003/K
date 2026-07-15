/**
 * AgentsPage — UI Simplification Task 16. The 3-tab hub shell (Org/Skills/Automations
 * — Impressive Wave Task 10 relabeled the "Pipelines" tab's visible text to
 * "Automations"; the route param/value stays `pipelines`, so `tab-pipelines` testid
 * and every `navigate('agents','pipelines',…)` assertion below are untouched)
 * mirroring PersonalPage's shape (Task 14). Gate assertions:
 *   - the tab bar renders all 3 tabs
 *   - the `tab` prop selects the matching tab (an unknown value falls back to org)
 *   - the `sub` prop threads through to the active child as its own seg/tab/defId prop
 *   - clicking a tab navigates to agents/<tab>
 *   - the default tab (no `tab` prop) is org
 * The three children (OrgPage/SkillsPage/WorkflowsView) are mocked to marker divs —
 * this file locks AgentsPage's OWN routing/mounting logic; each child's internals have
 * their own test files (org-page.test.tsx, skills-page-tabs.test.tsx, workflows-defs.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))
vi.mock('../src/pages/OrgPage', () => ({
  default: (p: { seg?: string }) => <div data-testid="org-page-mock">seg:{p.seg ?? 'none'}</div>,
}))
vi.mock('../src/pages/SkillsPage', () => ({
  default: (p: { tab?: string }) => <div data-testid="skills-page-mock">tab:{p.tab ?? 'none'}</div>,
}))
vi.mock('../src/pages/runs/WorkflowsView', () => ({
  default: (p: { defId?: string }) => <div data-testid="workflows-view-mock">defId:{p.defId ?? 'none'}</div>,
}))

import AgentsPage from '../src/pages/AgentsPage'

beforeEach(() => mockNavigate.mockClear())
afterEach(() => cleanup())

describe('AgentsPage', () => {
  it('renders all 3 tabs', () => {
    render(<AgentsPage />)
    expect(screen.getByTestId('tab-org')).toBeTruthy()
    expect(screen.getByTestId('tab-skills')).toBeTruthy()
    expect(screen.getByTestId('tab-pipelines')).toBeTruthy()
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

  it('tab=skills mounts SkillsPage with sub threaded as its tab prop', () => {
    render(<AgentsPage tab="skills" sub="mcp" />)
    expect(screen.getByTestId('tab-skills').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('skills-page-mock').textContent).toBe('tab:mcp')
    expect(screen.queryByTestId('org-page-mock')).toBeNull()
  })

  it('tab=pipelines mounts WorkflowsView with sub threaded as its defId prop', () => {
    render(<AgentsPage tab="pipelines" sub="def-1" />)
    expect(screen.getByTestId('tab-pipelines').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('workflows-view-mock').textContent).toBe('defId:def-1')
    expect(screen.queryByTestId('org-page-mock')).toBeNull()
  })

  it('clicking a tab navigates hash-routed rather than flipping local state', () => {
    render(<AgentsPage />)
    fireEvent.click(screen.getByTestId('tab-skills'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'skills')
    fireEvent.click(screen.getByTestId('tab-pipelines'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'pipelines')
    fireEvent.click(screen.getByTestId('tab-org'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'org')
  })
})
