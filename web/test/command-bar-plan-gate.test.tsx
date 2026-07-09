/**
 * P2 A3 — the ⌘K dispatch confirm card's "Plan first" toggle (E-02). Gate:
 *   1. toggling `dispatch-plan-gate` ON then firing the dispatch calls
 *      api.runs.start with `planGate: true` in the opts.
 *   2. the toggle is mutually exclusive with Interactive: checking
 *      `dispatch-interactive` DISABLES it and coerces it OFF (one-shot-only —
 *      the server throws on the combo).
 * api + route are mocked; a single @Demo project drives the dispatch path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import type { Status } from '@k/shared'

// Instant animations so the confirm card's AnimatePresence mount is synchronous.
MotionGlobalConfig.skipAnimations = true

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
  voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
}

const PROJECT = { id: 'p1', name: 'Demo', localPath: 'C:/tmp/demo' }

const { mockStart, mockNavigate } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: vi.fn(), undo: vi.fn() },
    runs: { start: mockStart, list: async () => [] },
    projects: { list: async () => [PROJECT] },
    claudeModel: { get: async () => ({ model: 'claude-sonnet-4-6', options: [] }) },
    status: async () => statusValue,
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))

// navigate must be a spy (don't touch window.location.hash); keep the other exports.
vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'home' }),
}))

import CommandBar from '../src/shell/CommandBar'

function renderBar(onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandBar open onClose={onClose} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView (CommandBar calls it on selection).
  Element.prototype.scrollIntoView = vi.fn()
  mockStart.mockReset()
  mockStart.mockResolvedValue({ id: 'run-xyz' })
  mockNavigate.mockClear()
})
afterEach(() => cleanup())

/** Type an @Demo dispatch query and open its compose/confirm card. */
async function openDispatchConfirm() {
  const input = screen.getByTestId('cmdk-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: '@Demo build the thing' } })
  fireEvent.click(await screen.findByTestId('cmdk-row-dispatch'))
  await screen.findByTestId('dispatch-confirm')
}

describe('CommandBar → dispatch plan-gate toggle', () => {
  it('toggling "Plan first" sends planGate:true to api.runs.start', async () => {
    renderBar()
    await openDispatchConfirm()

    fireEvent.click(screen.getByTestId('dispatch-plan-gate'))
    fireEvent.click(screen.getByTestId('dispatch-confirm-run'))

    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    expect(mockStart).toHaveBeenCalledWith('build the thing', expect.objectContaining({
      projectId: 'p1',
      interactive: false,
      planGate: true,
    }))
  })

  it('checking Interactive disables + coerces off Plan-first, and no planGate is sent', async () => {
    renderBar()
    await openDispatchConfirm()

    // Turn Plan-first ON, then Interactive ON — the plan-gate box must go disabled + unchecked.
    fireEvent.click(screen.getByTestId('dispatch-plan-gate'))
    fireEvent.click(screen.getByTestId('dispatch-interactive'))

    const planGateBox = screen.getByTestId('dispatch-plan-gate') as HTMLInputElement
    expect(planGateBox.disabled).toBe(true)
    expect(planGateBox.checked).toBe(false)

    // Firing now dispatches interactive WITHOUT planGate (the server throws on the combo).
    fireEvent.click(screen.getByTestId('dispatch-confirm-run'))
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    const opts = mockStart.mock.calls[0][1] as Record<string, unknown>
    expect(opts.interactive).toBe(true)
    expect('planGate' in opts).toBe(false)
  })

  // Quality-review WARNING regression: checking Interactive CLEARS plan-gate state (not
  // just masks its display), so toggling Interactive back off must NOT re-reveal it checked.
  it('toggling Interactive back off does not re-reveal a stale Plan-first', async () => {
    renderBar()
    await openDispatchConfirm()

    fireEvent.click(screen.getByTestId('dispatch-plan-gate'))   // Plan-first ON
    fireEvent.click(screen.getByTestId('dispatch-interactive')) // Interactive ON → clears planGate
    fireEvent.click(screen.getByTestId('dispatch-interactive')) // Interactive OFF again

    const planGateBox = screen.getByTestId('dispatch-plan-gate') as HTMLInputElement
    expect(planGateBox.disabled).toBe(false)
    expect(planGateBox.checked).toBe(false) // cleared, not merely masked
  })
})
