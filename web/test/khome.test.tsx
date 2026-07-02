/**
 * KHome — the K front-door landing page (P5.1f). Gate assertions:
 *   - a time-aware greeting renders
 *   - the glance line summarizes the chief-org (leads active · objectives) and its
 *     link navigates to the Chief view
 *   - typing shows the live route preview from routeForMessage (computed in-test)
 *   - Send calls api.k.ask once, navigates to the run, and raises the undo toast;
 *     Undo kills the run via api.runs.kill
 *   - work-items render one row per org objective with its lead chip
 *   - the recent feed renders runs with a View-run link that navigates
 * api + route.navigate are mocked (vi.hoisted, mirroring command-bar-ask-k.test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
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

const MSG = 'refactor the auth module'

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
  it('renders a time-aware greeting', () => {
    renderHome()
    const greeting = screen.getByTestId('khome-greeting')
    expect(greeting.textContent).toMatch(/Good (morning|afternoon|evening), Cameron\./)
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

  it('Send asks K once, opens the run, and Undo kills it', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(screen.getByTestId('khome-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG)
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-123'))

    const undo = await screen.findByTestId('khome-undo')
    expect(screen.getByTestId('khome-undo-toast')).toBeTruthy()
    fireEvent.click(undo)
    await waitFor(() => expect(mockKill).toHaveBeenCalledWith('run-123'))
    expect(mockKill).toHaveBeenCalledTimes(1)
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
})
