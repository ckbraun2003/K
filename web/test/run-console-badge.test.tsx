/**
 * RunConsole local-runtime badge (D-072 B4): "local · tools" vs
 * "local · prompt-only", derived PURELY from the ollama agent loop's system
 * declarations (run-start `toolSupport=…`, later "degraded to prompt-only").
 * Claude runs and legacy `ollama run` dispatches (no declaration) get NO badge.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run, AgentEvent, Status } from '@k/shared'

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: true, reachable: true, baseUrl: '', model: 'llama3.2' },
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

import RunConsole, { ollamaRuntimeBadge } from '../src/components/RunConsole'

const makeRun = (provider: Run['provider']): Run => ({
  id: 'r-badge', prompt: 'p', cwd: '/repo', status: 'done', provider,
  model: 'llama3.2', tokensIn: 10, tokensOut: 5, costUsd: 0, createdAt: 0,
})

let seq = 0
const sysEvent = (text: string): AgentEvent => ({
  id: `e-${seq}`, runId: 'r-badge', seq: seq++, type: 'system', ts: 0, text,
})

const RUN_START_TOOLS =
  'ollama-agent: model=llama3.2, tools=7 (native 6, mcp 1), skills=2, toolSupport=true'
const RUN_START_NO_TOOLS =
  'ollama-agent: model=llama3.2, tools=0 (native 0, mcp 0), skills=2, toolSupport=false'
const DEGRADE =
  'ollama-agent: model=llama3.2 rejected tools (400) — degraded to prompt-only, skills inlined'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => cleanup())

describe('ollamaRuntimeBadge (pure)', () => {
  it('is null for claude runs regardless of events', () => {
    expect(ollamaRuntimeBadge(makeRun('claude'), [sysEvent(RUN_START_TOOLS)])).toBeNull()
    expect(ollamaRuntimeBadge(undefined, [sysEvent(RUN_START_TOOLS)])).toBeNull()
  })

  it('is null for a legacy ollama run (no ollama-agent declaration)', () => {
    expect(ollamaRuntimeBadge(makeRun('ollama'), [])).toBeNull()
    expect(ollamaRuntimeBadge(makeRun('ollama'), [sysEvent('some other system note')])).toBeNull()
  })

  it('reads toolSupport from the run-start declaration', () => {
    expect(ollamaRuntimeBadge(makeRun('ollama'), [sysEvent(RUN_START_TOOLS)])).toBe('local · tools')
    expect(ollamaRuntimeBadge(makeRun('ollama'), [sysEvent(RUN_START_NO_TOOLS)])).toBe('local · prompt-only')
  })

  it('a later degrade event downgrades an initially-tools run', () => {
    expect(ollamaRuntimeBadge(makeRun('ollama'), [sysEvent(RUN_START_TOOLS), sysEvent(DEGRADE)]))
      .toBe('local · prompt-only')
  })
})

describe('RunConsole badge rendering', () => {
  function renderConsole(run: Run, events: AgentEvent[]) {
    mockGet.mockResolvedValue(run)
    mockEvents.mockResolvedValue(events)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <RunConsole runId={run.id} />
      </QueryClientProvider>,
    )
  }

  it('shows "local · tools" for a tool-loop ollama run', async () => {
    renderConsole(makeRun('ollama'), [sysEvent(RUN_START_TOOLS)])
    const badge = await screen.findByTestId('run-runtime-badge')
    expect(badge.textContent).toBe('local · tools')
  })

  it('shows "local · prompt-only" after a degrade', async () => {
    renderConsole(makeRun('ollama'), [sysEvent(RUN_START_TOOLS), sysEvent(DEGRADE)])
    const badge = await screen.findByTestId('run-runtime-badge')
    expect(badge.textContent).toBe('local · prompt-only')
  })

  it('renders no badge for a claude run', async () => {
    renderConsole(makeRun('claude'), [sysEvent(RUN_START_TOOLS)])
    // Wait for the header (model line) to render, then assert absence.
    await screen.findByText(/llama3\.2 · 10 in/)
    expect(screen.queryByTestId('run-runtime-badge')).toBeNull()
  })
})
