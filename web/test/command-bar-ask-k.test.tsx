/**
 * CommandBar → K front-door wiring (P5.1c2). The orchestrator's gate:
 *   1. a plain query shows the inline route preview from routeForMessage
 *   2. sending (click the ask-k row) calls api.k.ask exactly once with the message
 *   3. an undo toast appears; clicking Undo undoes the returned runId via api.k.undo
 *      (kill + dangling-turn removal, F-060)
 * api + route are mocked; the REAL routeForMessage (from @k/shared) drives the
 * expected label so the assertion tracks the router, not a hardcoded string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { routeForMessage, routeForTarget, type Status } from '@k/shared'

// framer-motion's rAF frameloop stalls after a fake-timers test, which would leave the
// optimistic undo toast's AnimatePresence exit hanging on a failed send (F-066). Make
// animations instant so mount/exit is synchronous and deterministic.
MotionGlobalConfig.skipAnimations = true

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false },
  voice: { enabled: true, reachable: true, baseUrl: 'x', model: 'm' },
}

// vi.hoisted so these are initialized before the (hoisted) vi.mock factories run
// — the factories reference them eagerly, so a plain const would hit a TDZ error.
const { mockAsk, mockUndo, mockNavigate } = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockUndo: vi.fn(async () => ({ undone: true })),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: mockAsk, undo: mockUndo },
    runs: { list: async () => [] },
    projects: { list: async () => [] },
    claudeModel: {
      get: async () => ({
        model: 'claude-sonnet-4-6',
        options: [
          { id: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ],
      }),
    },
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
  mockAsk.mockReset()
  mockUndo.mockClear()
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

  it('sending calls api.k.ask once + opens the run console, then Undo undoes the run', async () => {
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    const row = await screen.findByTestId('cmdk-row-ask-k')
    fireEvent.click(row)

    // (2) api.k.ask called exactly once with the typed message + the default
    // power-control opts ('default'/'' → no override).
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG, { model: undefined, forceRoute: undefined })
    // REQ 3: the run console is opened with the runId api.k.ask returned.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123'))

    // (3) undo toast surfaces with an Undo action; clicking it undoes the run.
    const undo = await screen.findByTestId('ask-k-undo')
    expect(screen.getByTestId('ask-k-undo-toast')).toBeTruthy()
    fireEvent.click(undo)

    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('run-123'))
    expect(mockUndo).toHaveBeenCalledTimes(1)
  })

  it('the footer power controls force the route (preview + send opts) and pick a model', async () => {
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: FE_MSG } })

    // Classifier preview first (frontend for a react/css message)…
    const preview = await screen.findByTestId('k-route-preview')
    expect(preview.textContent).toContain(routeForMessage(FE_MSG).label)

    // …then FORCE chief: the strip must show routeForTarget's label — the same
    // shared mapping the server applies — not the classifier's guess.
    fireEvent.change(screen.getByTestId('cmdk-force-route'), { target: { value: 'chief' } })
    await waitFor(() =>
      expect(screen.getByTestId('k-route-preview').textContent).toContain(routeForTarget('chief').label),
    )

    // Pick a model, send: both overrides ride the ask body.
    fireEvent.change(screen.getByTestId('cmdk-model-select'), { target: { value: 'claude-opus-4-8' } })
    fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(FE_MSG, { model: 'claude-opus-4-8', forceRoute: 'chief' })
  })

  it('a failed ask surfaces the error and raises no undo toast', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    renderBar()
    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))

    // The error shows in the footer; the send-anchored window is raised optimistically
    // (F-066) then torn down on the failure — waitFor lets the toast's exit settle so no
    // undo affordance lingers, and nothing was undone.
    await screen.findByText(/kaboom/)
    await waitFor(() => expect(screen.queryByTestId('ask-k-undo-toast')).toBeNull())
    expect(mockUndo).not.toHaveBeenCalled()
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
      // and the run is committed — api.k.undo is NEVER called (the send stands).
      await act(async () => { vi.advanceTimersByTime(5001) })
      await waitFor(() => expect(screen.queryByTestId('ask-k-undo-toast')).toBeNull())
      expect(mockUndo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // The bar closes on a COMMITTED send (runId resolved), NOT on the optimistic raise —
  // gate is `ask.pendingUndo?.runId`, not the mere pending entry (F-066). Spy on onClose
  // so a regression to bare `pendingUndo` (which would close the bar prematurely at the
  // optimistic raise, hiding an in-flight/failed send's footer error) is caught.
  it('does NOT close the bar on the optimistic raise, then closes once the ask resolves a runId', async () => {
    const onClose = vi.fn()
    // Deferred ask: stays pending until we resolve it, so we can observe the in-flight
    // window (optimistic undo raised, runId still null).
    let resolveAsk!: (v: unknown) => void
    mockAsk.mockImplementationOnce(() => new Promise(r => { resolveAsk = r }))
    renderBar(onClose)

    fireEvent.change(screen.getByTestId('cmdk-input') as HTMLInputElement, { target: { value: MSG } })
    fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))

    // In flight: the optimistic undo toast is up (runId null) but the bar must stay OPEN.
    await screen.findByTestId('ask-k-undo-toast')
    expect(onClose).not.toHaveBeenCalled()

    // Resolve → runId patched in → the bar closes exactly once.
    await act(async () => {
      resolveAsk({ kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(MSG), warm: false })
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('does NOT close the bar on a failed send (the footer error stays visible)', async () => {
    const onClose = vi.fn()
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    renderBar(onClose)

    fireEvent.change(screen.getByTestId('cmdk-input') as HTMLInputElement, { target: { value: MSG } })
    fireEvent.click(await screen.findByTestId('cmdk-row-ask-k'))

    // The optimistic window was raised then torn down; the bar never closed, so the
    // error remains readable in the footer.
    await screen.findByText(/kaboom/)
    expect(onClose).not.toHaveBeenCalled()
  })
})
