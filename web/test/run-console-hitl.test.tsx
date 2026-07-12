/**
 * RunConsole HITL answer box (awaiting_input branch).
 *
 * Unit-level coverage for the run-answer-box / run-answer-input / run-compact-btn
 * surfaces, added at UI Simplification Task 20 review: the e2e suite lost its live
 * awaiting_input coverage when the CommandBar dispatch entry points were retired
 * (phase4.spec.ts tests 6-8 — no spec produces an awaiting_input run anymore), so
 * the render contract is pinned here instead: the whole HITL cluster is visible
 * exactly while run.status === 'awaiting_input' and absent otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run, Status } from '@k/shared'

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
  voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
}

const { mockGet, mockEvents } = vi.hoisted(() => ({ mockGet: vi.fn(), mockEvents: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: { get: mockGet, events: mockEvents },
    status: async () => statusValue,
    projects: { list: async () => [] },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

import RunConsole from '../src/components/RunConsole'

const makeRun = (status: Run['status']): Run => ({
  id: 'r-hitl', prompt: 'p', cwd: '/repo', status, provider: 'claude',
  model: 'claude-haiku-4-5', tokensIn: 10, tokensOut: 5, costUsd: 0, createdAt: 0,
})

function renderConsole(run: Run) {
  mockGet.mockResolvedValue(run)
  mockEvents.mockResolvedValue([])
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunConsole runId={run.id} />
    </QueryClientProvider>,
  )
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => cleanup())

describe('RunConsole HITL answer box', () => {
  it('awaiting_input renders the full HITL cluster: answer box, input, compact + send buttons', async () => {
    renderConsole(makeRun('awaiting_input'))
    const box = await screen.findByTestId('run-answer-box')
    expect(box).toBeTruthy()
    expect(screen.getByTestId('run-answer-input')).toBeTruthy()
    expect(screen.getByTestId('run-compact-btn')).toBeTruthy()
    expect(screen.getByTestId('run-answer-send')).toBeTruthy()
    // Send is gated on a non-empty answer; Compact is immediately available.
    expect((screen.getByTestId('run-answer-send') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('run-compact-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('running and done runs render NO HITL surfaces', async () => {
    for (const status of ['running', 'done'] as const) {
      renderConsole(makeRun(status))
      // Wait for the header (model line) so the run record has loaded, then assert absence.
      await screen.findByText(/claude-haiku-4-5 · 10 in/)
      expect(screen.queryByTestId('run-answer-box')).toBeNull()
      expect(screen.queryByTestId('run-answer-input')).toBeNull()
      expect(screen.queryByTestId('run-compact-btn')).toBeNull()
      cleanup()
    }
  })
})
