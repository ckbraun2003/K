/**
 * CommandBar → K front-door wiring (P5.1c2). The orchestrator's gate:
 *   1. a plain query shows the inline route preview from routeForMessage
 *   2. sending (click the ask-k row) calls api.k.ask exactly once with the message
 *   3. an undo toast appears; clicking Undo kills the returned runId via api.runs.kill
 * api + route are mocked; the REAL routeForMessage (from @k/shared) drives the
 * expected label so the assertion tracks the router, not a hardcoded string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeForMessage, type Status } from '@k/shared'

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false },
  voice: { enabled: true, reachable: true, baseUrl: 'x', model: 'm' },
}

// vi.hoisted so these are initialized before the (hoisted) vi.mock factories run
// — the factories reference them eagerly, so a plain const would hit a TDZ error.
const { mockAsk, mockKill, mockNavigate } = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockKill: vi.fn(async () => ({ killed: true })),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: mockAsk },
    runs: { list: async () => [], kill: mockKill },
    projects: { list: async () => [] },
    status: async () => statusValue,
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))

// navigate must be a spy (don't touch window.location.hash); keep the real
// module's other exports so CommandBar/Sidebar imports don't break.
vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'home' }),
}))

import CommandBar from '../src/shell/CommandBar'

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandBar open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView (CommandBar calls it on selection).
  Element.prototype.scrollIntoView = vi.fn()
  mockAsk.mockReset()
  mockKill.mockClear()
  mockNavigate.mockClear()
  mockAsk.mockImplementation(async (message: string) => ({
    kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(message), warm: false,
  }))
})
afterEach(() => cleanup())

// 'auth' hits the security rule → 'Chief → Security Lead'; a react/css message hits
// the frontend rule → 'Chief → Frontend Lead'. Both labels are computed live below
// so the assertions track routeForMessage, not a hardcoded string.
const MSG = 'refactor the auth module'
const FE_MSG = 'update the react component css'

describe('CommandBar → K front door', () => {
  it('shows the inline route preview live from routeForMessage (hidden when empty)', async () => {
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement

    // Empty query → no route strip.
    expect(screen.queryByTestId('k-route-preview')).toBeNull()

    // A security-routed message shows its label…
    fireEvent.change(input, { target: { value: MSG } })
    const preview = await screen.findByTestId('k-route-preview')
    expect(preview.textContent).toContain(routeForMessage(MSG).label)

    // …and a differently-routed message updates the label (proves live compute,
    // not a value hardcoded for one route). The two labels differ.
    expect(routeForMessage(FE_MSG).label).not.toBe(routeForMessage(MSG).label)
    fireEvent.change(input, { target: { value: FE_MSG } })
    await waitFor(() =>
      expect(screen.getByTestId('k-route-preview').textContent).toContain(routeForMessage(FE_MSG).label),
    )
  })

  it('sending calls api.k.ask once + opens the run console, then Undo kills the run', async () => {
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    const row = await screen.findByTestId('cmdk-row-ask-k')
    fireEvent.click(row)

    // (2) api.k.ask called exactly once with the typed message.
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG)
    // REQ 3: the run console is opened with the runId api.k.ask returned.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123'))

    // (3) undo toast surfaces with an Undo action; clicking it kills the run.
    const undo = await screen.findByTestId('ask-k-undo')
    expect(screen.getByTestId('ask-k-undo-toast')).toBeTruthy()
    fireEvent.click(undo)

    await waitFor(() => expect(mockKill).toHaveBeenCalledWith('run-123'))
    expect(mockKill).toHaveBeenCalledTimes(1)
  })

  it('a failed ask surfaces the error and raises no undo toast', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))

    // The error shows in the footer; no run was started so there is no undo toast
    // and nothing to kill.
    await screen.findByText(/kaboom/)
    expect(screen.queryByTestId('ask-k-undo-toast')).toBeNull()
    expect(mockKill).not.toHaveBeenCalled()
  })

  it('auto-dismiss after the 5s window commits WITHOUT killing the run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderBar()
      fireEvent.change(screen.getByTestId('cmdk-input') as HTMLInputElement, { target: { value: MSG } })
      fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))
      await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
      expect(screen.getByTestId('ask-k-undo-toast')).toBeTruthy()
      // Let the 5s undo window elapse WITHOUT clicking Undo: the toast auto-dismisses
      // and the run is committed — api.runs.kill is NEVER called (the send stands).
      await act(async () => { vi.advanceTimersByTime(5001) })
      await waitFor(() => expect(screen.queryByTestId('ask-k-undo-toast')).toBeNull())
      expect(mockKill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
