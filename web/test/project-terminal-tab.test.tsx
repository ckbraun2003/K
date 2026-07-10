/**
 * P4 E-30 — the Terminal tab. ProjectWorkspace grew a canonical Tabs bar with a
 * final "Terminal" tab whose panel mounts the (relocated) TerminalPage. Selecting
 * tab="terminal" marks that tab aria-selected and mounts the terminal panel. The 7
 * real content tabs are stubbed so the happy path doesn't fan out real queries.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@k/shared'

const projects: Project[] = [
  { id: 'p1', name: 'Alpha', localPath: '/r', createdAt: 0 } as Project,
]

vi.mock('../src/lib/api', () => ({ api: { projects: { list: async () => projects } } }))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

// The relocated terminal — a cheap mock so we assert the panel mounted it without
// bringing up xterm/WebSocket.
vi.mock('../src/pages/TerminalPage', () => ({ default: () => <div data-testid="terminal-mock" /> }))

// Stub the 7 real content tabs so the happy path doesn't fan out real queries.
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

describe('ProjectWorkspace Terminal tab (P4 E-30)', () => {
  it('mounts the terminal in the Terminal panel and marks the tab selected', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ProjectWorkspace projectId="p1" tab="terminal" />
      </QueryClientProvider>,
    )
    await screen.findByTestId('terminal-mock')
    expect(screen.getByTestId('tab-terminal').getAttribute('aria-selected')).toBe('true')
  })
})
