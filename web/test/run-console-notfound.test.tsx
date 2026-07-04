/**
 * RunConsole not-found (F-002): a bad/removed run id 404s (api throws), and the
 * console must render a real not-found state instead of looping on "Loading…"
 * forever. Loading (query still pending) must stay distinct from the error state.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run, Status } from '@k/shared'

const makeRun = (id: string): Run => ({
  id, prompt: `run ${id}`, cwd: '/repo', status: 'done', provider: 'claude',
  model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0,
})

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false },
  voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
}

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: { get: mockGet, events: async () => [] },
    status: async () => statusValue,
    projects: { list: async () => [] },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

import RunConsole from '../src/components/RunConsole'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
beforeEach(() => mockGet.mockReset())
afterEach(() => cleanup())

function renderConsole() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunConsole runId="does-not-exist" />
    </QueryClientProvider>,
  )
}

describe('RunConsole not-found', () => {
  it('renders a not-found state (not infinite Loading) when the run query errors', async () => {
    // Seed the run query into an error state via prefetch (which swallows the
    // rejection internally) + refetchOnMount:false, so RunConsole reads the cached
    // 404 and never fires its own rejecting fetch. This asserts the same isError →
    // not-found rendering without a rejecting fetch escaping as an unhandled
    // rejection (which would fail the test).
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false } },
    })
    await qc.prefetchQuery({
      queryKey: ['run', 'does-not-exist'],
      queryFn: () => Promise.reject(new Error('404 Not Found')),
    })
    render(
      <QueryClientProvider client={qc}>
        <RunConsole runId="does-not-exist" />
      </QueryClientProvider>,
    )
    await screen.findByTestId('run-not-found')
    expect(screen.getByText('Run not found')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('shows Loading (not not-found) while the run query is still pending', async () => {
    // Controllable deferred: pending during the assertion, then settled so no
    // in-flight promise outlives the test and keeps the worker's event loop open
    // (a never-resolving queryFn would hang the run at teardown).
    let settle!: (r: Run) => void
    mockGet.mockReturnValue(new Promise<Run>(res => { settle = res }))
    renderConsole()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByTestId('run-not-found')).toBeNull()
    await act(async () => { settle(makeRun('r1')) })
  })
})
