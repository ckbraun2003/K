/**
 * KHome — the K front-door landing page (P5.1f). Gate assertions:
 *   - a time-aware greeting renders (no hardcoded operator name)
 *   - the glance line summarizes the chief-org (leads active · objectives) and its
 *     link navigates to the Chief view
 *   - typing shows the live route preview from routeForMessage (computed in-test)
 *   - Send calls api.k.ask once and raises the undo toast WITHOUT navigating away
 *     (K-home stays put — wave C1); the toast's "View run" link opens the run and
 *     Undo kills it via api.runs.kill
 *   - a second send inside the 5s window restarts the countdown and retargets Undo
 *     to the NEW run (Toast resetKey — wave C1)
 *   - chief-org / runs query failures render visible error states, not empty states
 *   - work-items render one row per org objective with its lead chip
 *   - the recent feed renders runs with a View-run link that navigates
 * api + route.navigate are mocked (vi.hoisted, mirroring command-bar-ask-k.test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeForMessage, type Status, type ChiefOrgPayload, type Run } from '@k/shared'

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false },
  voice: { enabled: true, reachable: true, baseUrl: 'x', model: 'm' },
}

const orgPayload: ChiefOrgPayload = {
  chief: null,
  leads: [],
  chiefWakes: [],
  assignments: [
    { id: 'a1', runId: null, lead: 'Frontend Lead', objective: 'Ship the auth refactor', note: null, workflow: null, projects: [], createdAt: 1, updatedAt: 1 },
    { id: 'a2', runId: null, lead: 'Backend Lead', objective: 'Harden the API surface', note: null, workflow: null, projects: [], createdAt: 2, updatedAt: 2 },
  ],
  health: { leadsActive: 3 },
}

const runsList: Run[] = [
  { id: 'run-1', prompt: 'added focus ring to the cmd bar', cwd: '/x', status: 'done', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now() - 60_000 },
  { id: 'run-2', prompt: 'auth refactor — diff +120 −44', cwd: '/x', status: 'running', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now() - 120_000 },
]

const { mockAsk, mockKill, mockList, mockOrg, mockStatus, mockNavigate } = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockKill: vi.fn(async () => ({ killed: true })),
  mockList: vi.fn(),
  mockOrg: vi.fn(),
  mockStatus: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: mockAsk },
    runs: { list: mockList, kill: mockKill },
    chief: { org: mockOrg },
    status: mockStatus,
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'home' }),
}))

import KHome from '../src/pages/KHome'

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <KHome />
    </QueryClientProvider>,
  )
}

// 'auth' hits the security rule; a react/css message hits the frontend rule — two
// DIFFERENT route labels, computed live so assertions track routeForMessage.
const MSG = 'refactor the auth module'
const FE_MSG = 'update the react component css'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  mockAsk.mockReset()
  mockKill.mockClear()
  mockNavigate.mockClear()
  mockList.mockResolvedValue(runsList)
  mockOrg.mockResolvedValue(orgPayload)
  mockStatus.mockResolvedValue(statusValue)
  mockAsk.mockImplementation(async (message: string) => ({
    kThreadId: 'kt', agentRunId: 'ar', runId: 'run-123', route: routeForMessage(message), warm: false,
  }))
})
afterEach(() => cleanup())

describe('KHome', () => {
  it('renders a time-aware greeting without a hardcoded name', () => {
    renderHome()
    const greeting = screen.getByTestId('khome-greeting')
    expect(greeting.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/)
  })

  it('glance summarizes the org and links to Chief', async () => {
    renderHome()
    const glance = await screen.findByTestId('khome-glance')
    // 3 leads active · 2 objectives in flight (wait for the chief-org query to load)
    await waitFor(() => expect(glance.textContent).toMatch(/3 leads active/))
    expect(glance.textContent).toMatch(/2 objectives in flight/)

    fireEvent.click(screen.getByTestId('khome-glance-link'))
    expect(mockNavigate).toHaveBeenCalledWith('chief')
  })

  it('shows the live route preview only when the composer is non-empty', async () => {
    renderHome()
    expect(screen.queryByTestId('khome-route-preview')).toBeNull()

    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    const preview = await screen.findByTestId('khome-route-preview')
    expect(preview.textContent).toContain(routeForMessage(MSG).label)
  })

  it('Send asks K once, stays on K-home (no navigation), and Undo kills the run', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(screen.getByTestId('khome-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG)

    // The undo toast raises IN PLACE — K-home must NOT auto-navigate to the run
    // (navigating would unmount the page and kill this very toast).
    const undo = await screen.findByTestId('khome-undo')
    expect(screen.getByTestId('khome-undo-toast')).toBeTruthy()
    expect(mockNavigate).not.toHaveBeenCalled()

    fireEvent.click(undo)
    await waitFor(() => expect(mockKill).toHaveBeenCalledWith('run-123'))
    expect(mockKill).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('the toast View-run link navigates to the started run', async () => {
    renderHome()
    fireEvent.change(screen.getByTestId('khome-composer'), { target: { value: MSG } })
    fireEvent.click(screen.getByTestId('khome-send'))

    const viewRun = await screen.findByTestId('khome-view-run')
    expect(mockNavigate).not.toHaveBeenCalled() // send alone never navigates
    fireEvent.click(viewRun)
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123')
    expect(mockKill).not.toHaveBeenCalled() // viewing ≠ undoing
  })

  it('a second send inside the undo window restarts the 5s countdown and retargets Undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let n = 0
      mockAsk.mockImplementation(async (message: string) => {
        n += 1
        return { kThreadId: 'kt', agentRunId: 'ar', runId: `run-${n}`, route: routeForMessage(message), warm: false }
      })
      renderHome()
      const input = screen.getByTestId('khome-composer') as HTMLInputElement

      // message 1 → run-1
      fireEvent.change(input, { target: { value: MSG } })
      fireEvent.click(screen.getByTestId('khome-send'))
      await screen.findByTestId('khome-undo-toast')

      // ~3s into run-1's 5s window, send message 2 → run-2 (a different route label)
      await act(async () => { vi.advanceTimersByTime(3000) })
      fireEvent.change(input, { target: { value: FE_MSG } })
      fireEvent.click(screen.getByTestId('khome-send'))
      await waitFor(() =>
        expect(screen.getByTestId('khome-undo-toast').textContent).toContain(routeForMessage(FE_MSG).label),
      )

      // Another ~2.5s (≈5.5s total): past run-1's original 5s deadline but well
      // inside run-2's FRESH 5s window — the toast must still be open, showing the
      // second run's route. (2.5s, not 3s: under shouldAdvanceTime the fake clock
      // also creeps with real time, so the wider margin keeps a slow CI box from
      // dismissing run-2's toast before the assertions run.)
      await act(async () => { vi.advanceTimersByTime(2500) })
      const toast = screen.getByTestId('khome-undo-toast')
      expect(toast.textContent).toContain(routeForMessage(FE_MSG).label)
      expect(toast.textContent).not.toContain(routeForMessage(MSG).label)

      // Undo kills run-2 ONLY (never the already-committed run-1).
      fireEvent.click(screen.getByTestId('khome-undo'))
      await waitFor(() => expect(mockKill).toHaveBeenCalledWith('run-2'))
      expect(mockKill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed send surfaces the error, keeps the typed text, and raises no undo toast', async () => {
    mockAsk.mockRejectedValueOnce(new Error('kaboom'))
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(screen.getByTestId('khome-send'))

    // The error shows under the composer; the prompt is NOT wiped (retryable) and
    // no run started so there is no undo toast.
    await screen.findByTestId('khome-send-error')
    expect(screen.getByTestId('khome-send-error').textContent).toMatch(/kaboom/)
    expect((screen.getByTestId('khome-composer') as HTMLInputElement).value).toBe(MSG)
    expect(screen.queryByTestId('khome-undo-toast')).toBeNull()
    expect(mockKill).not.toHaveBeenCalled()
  })

  it('Enter in the composer sends', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockAsk).toHaveBeenCalledWith(MSG))
  })

  it('renders one work-item row per org objective with a lead chip', async () => {
    renderHome()
    const section = await screen.findByTestId('khome-workitems')
    // Wait for the chief-org query to populate the objective rows.
    expect(await within(section).findByText('Ship the auth refactor')).toBeTruthy()
    expect(within(section).getByText('Harden the API surface')).toBeTruthy()
    // The lead chip surfaces the assignment's lead.
    expect(within(section).getByText('Frontend Lead')).toBeTruthy()
    expect(within(section).getByText('Backend Lead')).toBeTruthy()
  })

  it('renders the recent feed with View-run links that navigate', async () => {
    renderHome()
    const section = await screen.findByTestId('khome-recent')
    // Wait for the runs query to populate the feed rows.
    expect(await within(section).findByText(/added focus ring/)).toBeTruthy()

    const links = within(section).getAllByText(/View run/)
    fireEvent.click(links[0])
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-1')
  })

  it('a chief-org failure surfaces glance + work-items error states (not fake zeros)', async () => {
    mockOrg.mockRejectedValue(new Error('org down'))
    renderHome()

    expect(await screen.findByTestId('khome-workitems-error')).toBeTruthy()
    expect(screen.getByTestId('khome-glance-error')).toBeTruthy()
    // The Chief link keeps working even while the glance is degraded.
    fireEvent.click(screen.getByTestId('khome-glance-link'))
    expect(mockNavigate).toHaveBeenCalledWith('chief')
  })

  it('a runs failure surfaces the recent-feed error state', async () => {
    mockList.mockRejectedValue(new Error('runs down'))
    renderHome()
    expect(await screen.findByTestId('khome-recent-error')).toBeTruthy()
  })
})
