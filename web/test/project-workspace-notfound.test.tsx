/**
 * ProjectWorkspace not-found gate (F-003): once the project list has loaded and
 * the id matches nothing, render a clean not-found and DO NOT render the tab bar
 * or the action buttons (which would POST against a nonexistent id and spray
 * console errors from each tab's own failing query). A valid id still renders the
 * tabs. Tab children are stubbed so the two paths are asserted in isolation.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@k/shared'

const projects: Project[] = [
  { id: 'p1', name: 'Alpha', localPath: '/repo/alpha', createdAt: 0 } as Project,
]

vi.mock('../src/lib/api', () => ({ api: { projects: { list: async () => projects } } }))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

// Stub every tab so mounting the happy path doesn't fan out real queries. Each
// factory returns a bare `() => null` component — no JSX and no outer reference,
// since vi.mock factories are hoisted above everything else in the module.
vi.mock('../src/pages/tabs/OverviewTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/VerificationTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/ArtifactsTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/RunsTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/TasksTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/PrsCiTab', () => ({ default: () => null }))
vi.mock('../src/pages/tabs/KnowledgeGraphTab', () => ({ default: () => null }))

import ProjectWorkspace from '../src/pages/ProjectWorkspace'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => cleanup())

function renderWorkspace(projectId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ProjectWorkspace projectId={projectId} tab="overview" />
    </QueryClientProvider>,
  )
}

describe('ProjectWorkspace not-found', () => {
  it('a bad id (after projects load) renders not-found with NO tabs/actions', async () => {
    renderWorkspace('does-not-exist')
    await screen.findByTestId('project-not-found')
    // No tab bar and no tab panels rendered → no action buttons can POST a bad id.
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByText('Project not found')).toBeTruthy()
  })

  it('a valid id renders the tabs (guard does not false-trigger)', async () => {
    renderWorkspace('p1')
    // ProjectWorkspace's own header/tab-bar render for a real project.
    await screen.findByRole('heading', { name: 'Alpha' })
    expect(screen.queryByTestId('project-not-found')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(8)
  })
})
