/**
 * MessageDock dispatch semantics (UI Simplification Task 9) — ports CommandBar's
 * @project dispatch flow into the dock: a deterministic route preview for plain
 * (non-@) text (dock-route-preview), and an @project picker (dock-project-row-<id>)
 * -> confirm card (dock-dispatch-card) -> api.runs.start with CommandBar's
 * fireDispatch payload shape 1:1 (cwd/projectId/model opts, interactive (+/-
 * planGate mutual exclusion). Mocks api at the same seam message-dock.test.tsx /
 * command-bar-plan-gate.test.tsx use — no real network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { routeForMessage } from '@k/shared'
import type { Status } from '@k/shared'

// framer-motion's rAF frameloop can stall a test — mirrors message-dock.test.tsx's
// guard so the confirm card's AnimatePresence mount/exit is synchronous.
MotionGlobalConfig.skipAnimations = true

const PROJECTS = [
  { id: 'p1', name: 'Demo', localPath: 'C:/tmp/demo' },
  { id: 'p2', name: 'Other', localPath: 'C:/tmp/other' },
]

// Default status: Ollama off → the picker's static "Ollama (local)" label
// (mirrors command-bar-plan-gate.test.tsx's statusValue shape).
const STATUS_OLLAMA_OFF: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
  voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
}

const { mockThreadsList, mockAsk, mockProjectsList, mockRunsStart, mockNavigate, mockInbox, mockStatus } = vi.hoisted(() => ({
  mockThreadsList: vi.fn(),
  mockAsk: vi.fn(),
  mockProjectsList: vi.fn(),
  mockRunsStart: vi.fn(),
  mockNavigate: vi.fn(),
  mockInbox: vi.fn(),
  mockStatus: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    threads: { list: mockThreadsList, get: vi.fn(), create: vi.fn() },
    k: { ask: mockAsk, undo: vi.fn() },
    projects: { list: mockProjectsList },
    runs: { start: mockRunsStart },
    status: mockStatus,
    claudeModel: {
      get: async () => ({
        model: 'claude-sonnet-4-6',
        options: [
          { id: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ],
      }),
    },
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
vi.mock('../src/lib/inbox-query', () => ({ INBOX_KEY: ['inbox'], inboxQueryFn: mockInbox }))
// navigate must be a spy (don't touch window.location.hash) — mirrors
// command-bar-plan-gate.test.tsx's minimal route mock.
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import MessageDock from '../src/shell/MessageDock'
import { selectThread } from '../src/lib/thread-select'

function renderDock(variant: 'bar' | 'float' = 'bar') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageDock variant={variant} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  selectThread(null)
  mockThreadsList.mockReset()
  mockThreadsList.mockResolvedValue({ threads: [] })
  mockAsk.mockReset()
  mockProjectsList.mockReset()
  mockProjectsList.mockResolvedValue(PROJECTS)
  mockRunsStart.mockReset()
  mockRunsStart.mockResolvedValue({ id: 'run-xyz' })
  mockNavigate.mockClear()
  mockInbox.mockReset()
  mockInbox.mockResolvedValue({ items: [], counts: {}, total: 0 })
  mockStatus.mockReset()
  mockStatus.mockResolvedValue(STATUS_OLLAMA_OFF)
})
afterEach(() => {
  cleanup()
  selectThread(null)
})

/** Type an @Demo dispatch message and open its confirm card via the picker row. */
async function openDispatchConfirm() {
  fireEvent.change(screen.getByTestId('dock-input'), { target: { value: '@Demo build the thing' } })
  fireEvent.click(await screen.findByTestId('dock-project-row-p1'))
  await screen.findByTestId('dock-dispatch-card')
}

describe('MessageDock dispatch semantics', () => {
  it('shows the deterministic route preview while typing', async () => {
    renderDock('bar')
    expect(screen.queryByTestId('dock-route-preview')).toBeNull()

    fireEvent.change(screen.getByTestId('dock-input'), { target: { value: 'fix the login bug' } })
    const preview = await screen.findByTestId('dock-route-preview')
    expect(preview.textContent).toBe(`→ ${routeForMessage('fix the login bug').label}`)
  })

  it('"@" prefix lists projects; picking one opens the confirm card', async () => {
    renderDock('bar')
    // No route preview for @-prefixed text.
    fireEvent.change(screen.getByTestId('dock-input'), { target: { value: '@Demo build the thing' } })
    expect(screen.queryByTestId('dock-route-preview')).toBeNull()

    const row = await screen.findByTestId('dock-project-row-p1')
    expect(screen.queryByTestId('dock-project-row-p2')).toBeNull()

    fireEvent.click(row)
    await screen.findByTestId('dock-dispatch-card')
    expect((screen.getByTestId('dock-dispatch-compose') as HTMLTextAreaElement).value).toBe('build the thing')
  })

  it('interactive checkbox disables + clears plan-first', async () => {
    renderDock('bar')
    await openDispatchConfirm()

    fireEvent.click(screen.getByTestId('dock-dispatch-plan-gate'))
    fireEvent.click(screen.getByTestId('dock-dispatch-interactive'))

    const planGateBox = screen.getByTestId('dock-dispatch-plan-gate') as HTMLInputElement
    expect(planGateBox.disabled).toBe(true)
    expect(planGateBox.checked).toBe(false)

    // Toggling Interactive back off must not re-reveal a stale Plan-first
    // (parity with CommandBar's "coerced off, not merely masked" regression test).
    fireEvent.click(screen.getByTestId('dock-dispatch-interactive'))
    expect((screen.getByTestId('dock-dispatch-plan-gate') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('dock-dispatch-plan-gate') as HTMLInputElement).disabled).toBe(false)
  })

  it('Dispatch calls api.runs.start with cwd/projectId/model opts and navigates to the run', async () => {
    renderDock('bar')
    await openDispatchConfirm()

    fireEvent.click(screen.getByTestId('dock-dispatch-run'))

    await waitFor(() => expect(mockRunsStart).toHaveBeenCalledTimes(1))
    const proj = PROJECTS[0]
    expect(mockRunsStart).toHaveBeenCalledWith('build the thing', expect.objectContaining({
      cwd: proj.localPath,
      projectId: proj.id,
      interactive: false,
    }))
    // Exact parity with fireDispatch: planGate is ABSENT (not false) when unchecked.
    const opts = mockRunsStart.mock.calls[0][1] as Record<string, unknown>
    expect('planGate' in opts).toBe(false)

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-xyz'))
    await waitFor(() => expect(screen.queryByTestId('dock-dispatch-card')).toBeNull())
  })

  it('model picker surfaces the live Ollama model from the status query', async () => {
    mockStatus.mockResolvedValue({
      ...STATUS_OLLAMA_OFF,
      ollama: { enabled: true, reachable: true, baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
    })
    renderDock('bar')
    await openDispatchConfirm()

    const select = screen.getByTestId('dock-dispatch-model') as HTMLSelectElement
    // The status query resolves async — wait for the live label to land.
    await waitFor(() => {
      expect(Array.from(select.options).map(o => o.textContent)).toContain('Ollama · llama3.2')
    })
    // The VALUE stays 'ollama' so modelChoiceToOpts still maps it to preferLocal.
    const ollamaOpt = Array.from(select.options).find(o => o.textContent === 'Ollama · llama3.2')
    expect(ollamaOpt?.value).toBe('ollama')
  })

  it('focus trap: Tab on the last focusable (Dispatch) wraps back to the first (compose) — UIS-FU-1', async () => {
    renderDock('bar')
    await openDispatchConfirm()

    const dispatchBtn = screen.getByTestId('dock-dispatch-run')
    dispatchBtn.focus()
    expect(document.activeElement).toBe(dispatchBtn)

    fireEvent.keyDown(dispatchBtn, { key: 'Tab' })

    expect(document.activeElement).toBe(screen.getByTestId('dock-dispatch-compose'))
  })
})
