/**
 * ChiefPage — C2 actuation surfaces. Gate assertions:
 *   - the reassign flow: per-objective select + button → ConfirmDialog naming
 *     old → new → api.chief.reassign on confirm; a 409 surfaces IN the dialog
 *   - inspector actions via DelegationTree renderActions: Open lead / View run /
 *     Stop run (ConfirmDialog-gated kill) on a live lead node
 *   - the hand-Chief-work composer sends through the shared front door with a
 *     FORCED chief route and raises the undo toast without navigating
 * api + route.navigate are mocked (vi.hoisted, mirroring khome.test.tsx).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChiefOrgPayload, ChiefOrgLead, AgentProfile, Run } from '@k/shared'

// jsdom has no matchMedia; framer-motion may probe it. Provide an inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

function profile(id: string, name: string, over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id, name, tier: 'orchestrator', charter: 'orchestrator', defaultModel: null,
    allowedTools: [], mcpServers: [], skills: [], ...over,
  }
}

const leadRun: Run = {
  id: 'run-be', prompt: 'Ship the auth refactor', cwd: '/repo', status: 'running',
  provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0,
}

const backendLead: ChiefOrgLead = {
  profile: profile('lead-backend', 'Backend'),
  latestRun: leadRun,
  events: [],
  wakes: [],
}

const systemsLead: ChiefOrgLead = {
  profile: profile('lead-systems', 'Systems'),
  latestRun: null,
  events: [],
  wakes: [],
}

const orgPayload: ChiefOrgPayload = {
  chief: profile('chief', 'Chief', { tier: 'chief', charter: 'chief' }),
  leads: [backendLead, systemsLead],
  chiefWakes: [],
  assignments: [
    {
      id: 'a1', runId: null, lead: 'Backend', objective: 'Ship the auth refactor',
      note: null, workflow: null, projects: [], leadRunId: null, createdAt: 1, updatedAt: 1,
    },
  ],
  health: { leadsActive: 1 },
  kDelegations: 0,
  leadsActive: 1,
}

const { mockOrg, mockReassign, mockKill, mockAsk, mockNavigate } = vi.hoisted(() => ({
  mockOrg: vi.fn(),
  mockReassign: vi.fn(),
  mockKill: vi.fn(async () => ({ killed: true })),
  mockAsk: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    chief: { org: mockOrg, reassign: mockReassign },
    runs: { kill: mockKill },
    k: { ask: mockAsk },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'chief' }),
}))

import ChiefPage from '../src/pages/org/TreeView'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChiefPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockOrg.mockReset()
  mockReassign.mockReset()
  mockKill.mockClear()
  mockAsk.mockReset()
  mockNavigate.mockClear()
  mockOrg.mockResolvedValue(orgPayload)
  mockReassign.mockResolvedValue({ ...orgPayload.assignments[0], lead: 'Systems' })
  mockAsk.mockImplementation(async () => ({
    kThreadId: 'kt', agentRunId: 'ar', runId: 'run-chief-1',
    route: { target: 'chief', label: 'Chief', escalates: true }, warm: false,
  }))
})
afterEach(() => cleanup())

describe('ChiefPage — reassign flow', () => {
  it('confirming the dialog reassigns via the API and refetches the org', async () => {
    renderPage()
    await screen.findByTestId('chief-objective-a1')

    // Pick a DIFFERENT lead — the button enables only when the selection moves.
    const select = screen.getByTestId('chief-reassign-select-a1') as HTMLSelectElement
    expect(select.value).toBe('lead-backend') // defaulted to the current lead
    expect((screen.getByTestId('chief-reassign-a1') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'lead-systems' } })
    fireEvent.click(screen.getByTestId('chief-reassign-a1'))

    // The confirm dialog names old → new.
    const dialog = await screen.findByTestId('chief-reassign-dialog')
    expect(dialog.textContent).toContain('Backend')
    expect(dialog.textContent).toContain('Systems')

    fireEvent.click(screen.getByTestId('chief-reassign-dialog-confirm'))
    await waitFor(() => expect(mockReassign).toHaveBeenCalledWith('a1', 'lead-systems'))
    // Success closes the dialog and invalidates chief-org (a refetch happens).
    await waitFor(() => expect(screen.queryByTestId('chief-reassign-dialog')).toBeNull())
    await waitFor(() => expect(mockOrg.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('a 409 surfaces inside the dialog instead of silently failing', async () => {
    mockReassign.mockRejectedValue(new Error('lead run is live'))
    renderPage()
    await screen.findByTestId('chief-objective-a1')

    fireEvent.change(screen.getByTestId('chief-reassign-select-a1'), { target: { value: 'lead-systems' } })
    fireEvent.click(screen.getByTestId('chief-reassign-a1'))
    fireEvent.click(await screen.findByTestId('chief-reassign-dialog-confirm'))

    const error = await screen.findByTestId('chief-reassign-dialog-error')
    expect(error.textContent).toContain('lead run is live')
    // The dialog stays open — the operator sees WHY and can cancel.
    expect(screen.getByTestId('chief-reassign-dialog')).toBeTruthy()
  })
})

describe('ChiefPage — objective card', () => {
  it('shows the objective status (pending until dispatched) and its created-at (F-083)', async () => {
    renderPage()
    await screen.findByTestId('chief-objective-a1')
    // leadRunId is null in the fixture → not yet dispatched.
    expect(screen.getByTestId('chief-objective-status-a1').textContent).toContain('pending')
    expect(screen.getByTestId('chief-objective-created-a1').textContent).toContain('created')
    expect(screen.getByTestId('chief-objective-created-a1').textContent).toContain('ago')
  })

  it("reads 'dispatched' once the objective has a lead run", async () => {
    mockOrg.mockResolvedValue({
      ...orgPayload,
      assignments: [{ ...orgPayload.assignments[0], leadRunId: 'run-be' }],
    })
    renderPage()
    await screen.findByTestId('chief-objective-a1')
    expect(screen.getByTestId('chief-objective-status-a1').textContent).toContain('dispatched')
  })
})

describe('ChiefPage — inspector actions', () => {
  it('a live lead node offers Open lead / View run / Stop run (confirm-gated kill)', async () => {
    renderPage()
    // Select the backend lead node in the whole-org tree.
    fireEvent.click(await screen.findByTestId('delegation-tree-node-lead-backend'))

    fireEvent.click(screen.getByTestId('chief-open-lead'))
    expect(mockNavigate).toHaveBeenCalledWith('orchestrator', 'lead-backend')

    fireEvent.click(screen.getByTestId('chief-view-run'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-be')

    // Stop run is destructive → ConfirmDialog first; confirm kills + refetches.
    fireEvent.click(screen.getByTestId('chief-stop-run'))
    await screen.findByTestId('chief-stop-dialog')
    fireEvent.click(screen.getByTestId('chief-stop-dialog-confirm'))
    await waitFor(() => expect(mockKill).toHaveBeenCalledWith('run-be'))
    await waitFor(() => expect(screen.queryByTestId('chief-stop-dialog')).toBeNull())
  })

  it('an idle lead node offers Open lead but no View/Stop run (no run to act on)', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('delegation-tree-node-lead-systems'))
    expect(screen.getByTestId('chief-open-lead')).toBeTruthy()
    expect(screen.queryByTestId('chief-view-run')).toBeNull()
    expect(screen.queryByTestId('chief-stop-run')).toBeNull()
  })
})

describe('ChiefPage — hand Chief work', () => {
  it('sends through the shared front door with a FORCED chief route, no navigation', async () => {
    renderPage()
    const composer = await screen.findByTestId('chief-hand-composer')
    const input = composer.querySelector('input') as HTMLInputElement
    // The caption is static + honest: the route is forced, not classified.
    expect(composer.textContent).toContain('will hand to Chief')

    fireEvent.change(input, { target: { value: 'rebalance the leads' } })
    fireEvent.click(screen.getByTestId('chief-hand-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith('rebalance the leads', { forceRoute: 'chief' })

    // The undo toast raises in place (navigateOnSend:false) with a View-run link.
    await screen.findByTestId('chief-hand-toast')
    expect(mockNavigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('chief-hand-view-run'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-chief-1')
    // A successful send clears the composer.
    expect(input.value).toBe('')
  })
})
