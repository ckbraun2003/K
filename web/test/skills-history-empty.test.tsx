/**
 * SkillsPage — F-051: expanding a skill's run history with 0 runs must render an
 * empty-state ("No runs yet."), not literally nothing. Regression lock.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Skill } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockList, mockEvals, mockRuns, mockProjects } = vi.hoisted(() => ({
  mockList: vi.fn(), mockEvals: vi.fn(), mockRuns: vi.fn(), mockProjects: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    skills: { list: mockList, evals: mockEvals, runs: mockRuns },
    // SkillsPage loads registered projects for the per-skill "▶ run" project selector (F-069).
    projects: { list: mockProjects },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import SkillsPage from '../src/pages/SkillsPage'

const skill: Skill = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'nightly-verify', type: 'skill', source: 'do things',
  triggerType: 'manual', enabled: true, createdAt: 0,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SkillsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockList.mockReset(); mockEvals.mockReset(); mockRuns.mockReset(); mockProjects.mockReset()
  mockList.mockResolvedValue([skill]); mockEvals.mockResolvedValue([]); mockRuns.mockResolvedValue([])
  mockProjects.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('SkillsPage — F-051 empty run history', () => {
  it('shows "No runs yet." when the expanded history has zero runs', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('skill-history-toggle'))
    // Wait for the (empty) runs query to resolve past its "Loading…" state.
    await screen.findByText('No runs yet.')
    expect(screen.getByTestId('skill-run-history').textContent).toContain('No runs yet.')
  })
})
