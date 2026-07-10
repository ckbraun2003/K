/**
 * KHome — the K front-door landing page (P5.1f → C2 parity). Gate assertions:
 *   - a time-aware greeting renders (no hardcoded operator name)
 *   - the glance line summarizes the chief-org (leads active · objectives) and its
 *     link navigates to the Chief view
 *   - typing shows the live route preview from routeForMessage (computed in-test);
 *     a FORCED route overrides it with routeForTarget's label (honest preview)
 *   - the power controls (model select · force-route select) ride the send opts
 *   - Send calls api.k.ask once and raises the undo toast WITHOUT navigating away
 *     (K-home stays put — wave C1); the toast's "View run" link opens the run and
 *     Undo undoes it via api.k.undo (kill + dangling-turn removal, F-060)
 *   - a second send inside the 5s window restarts the countdown and retargets Undo
 *     to the NEW run (Toast resetKey — wave C1)
 *   - the Notes / Schedule / Your-work cards render their reads, empty states, and
 *     error states; work-item toggle PATCHes and the add composer POSTs (C2)
 *   - chief-org / runs / card query failures render visible error states
 * api + route.navigate are mocked (vi.hoisted, mirroring command-bar-ask-k.test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { routeForMessage, routeForTarget, type Status, type ChiefOrgPayload, type Note, type KSchedule, type WorkItem, type KThread, type KThreadTurn, type FeedItem, type FeedPayload } from '@k/shared'

// framer-motion's rAF frameloop stalls after a sibling test uses vi.useFakeTimers (the
// "second send" test), which would otherwise leave AnimatePresence exits hanging — e.g.
// the optimistic undo toast tearing down on a failed send (F-066). Make animations
// instant so mount/exit is synchronous and deterministic across the file.
MotionGlobalConfig.skipAnimations = true

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
  voice: { enabled: true, reachable: true, baseUrl: 'x', model: 'm' },
}

const orgPayload: ChiefOrgPayload = {
  chief: null,
  leads: [],
  chiefWakes: [],
  assignments: [
    { id: 'a1', runId: null, lead: 'Frontend Lead', objective: 'Ship the auth refactor', note: null, workflow: null, projects: [], leadRunId: null, createdAt: 1, updatedAt: 1 },
    { id: 'a2', runId: null, lead: 'Backend Lead', objective: 'Harden the API surface', note: null, workflow: null, projects: [], leadRunId: null, createdAt: 2, updatedAt: 2 },
  ],
  health: { leadsActive: 3 },
}

// The recent list now reads the shared ['feed'] key (api.feed.list), not api.runs.list.
const feedItems: FeedItem[] = [
  { id: 'f1', kind: 'done', ts: Date.now() - 60_000, runId: 'run-1', runStatus: 'done', projectId: null, projectName: 'web', title: 'added focus ring to the cmd bar', detail: null },
  { id: 'f2', kind: 'dispatch', ts: Date.now() - 120_000, runId: 'run-2', runStatus: 'running', projectId: null, projectName: 'core', title: 'auth refactor dispatched', detail: null },
]
const feedPayload: FeedPayload = {
  items: feedItems,
  counts: { dispatch: 1, park: 0, plan_gate: 0, review_ready: 0, pr: 0, merge: 0, verify_pass: 0, verify_fail: 0, failure: 0, done: 1 },
  total: 2,
}

const notesList: Note[] = [
  { id: 'n1', runId: null, body: 'call re: API rate limits', done: false, createdAt: 1, updatedAt: 1 },
  { id: 'n2', runId: null, body: 'idea: cache the graph layout', done: true, createdAt: 2, updatedAt: 2 },
]

const scheduleValue: KSchedule = {
  events: [
    { id: 'ev1', runId: null, title: 'design sync', startsAt: Date.now() + 3_600_000, endsAt: null, location: null, createdAt: 1, updatedAt: 1 },
  ],
  reminders: [
    { id: 'rm1', runId: null, text: 'renew the domain', remindAt: Date.now() - 60_000, status: 'pending', createdAt: 1, updatedAt: 1 },
  ],
}

const workItemsList: WorkItem[] = [
  { id: 'wi1', runId: null, title: 'triage PR #42', body: null, status: 'open', scope: 'personal', createdAt: 1, updatedAt: 1 },
  { id: 'wi2', runId: null, title: 'build graph', body: null, status: 'done', scope: 'personal', createdAt: 2, updatedAt: 2 },
  { id: 'wi3', runId: null, title: 'verify core', body: null, status: 'blocked', scope: 'personal', createdAt: 3, updatedAt: 3 },
]

const threadValue: KThread = { id: 'k-default', title: null, status: 'idle', activeRunId: null, createdAt: 1, updatedAt: 2 }
const threadTurns: KThreadTurn[] = [
  { id: 't1', threadId: 'k-default', role: 'user', text: 'remind me to prep the notes', runId: 'r1', createdAt: 1 },
  { id: 't2', threadId: 'k-default', role: 'k', text: 'Noted — I added a reminder for you.', runId: 'r1', createdAt: 2 },
]

const {
  mockAsk, mockUndo, mockFeed, mockOrg, mockStatus, mockNavigate,
  mockNotes, mockSchedule, mockWiList, mockWiCreate, mockWiSetStatus, mockClaudeModel, mockThread,
} = vi.hoisted(() => ({
  mockAsk: vi.fn(),
  mockUndo: vi.fn(async () => ({ undone: true })),
  mockFeed: vi.fn(),
  mockOrg: vi.fn(),
  mockStatus: vi.fn(),
  mockNavigate: vi.fn(),
  mockNotes: vi.fn(),
  mockSchedule: vi.fn(),
  mockWiList: vi.fn(),
  mockWiCreate: vi.fn(),
  mockWiSetStatus: vi.fn(),
  mockClaudeModel: vi.fn(),
  mockThread: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: {
      ask: mockAsk,
      undo: mockUndo,
      thread: mockThread,
      notes: mockNotes,
      schedule: mockSchedule,
      workItems: { list: mockWiList, create: mockWiCreate, setStatus: mockWiSetStatus },
    },
    feed: { list: mockFeed },
    chief: { org: mockOrg },
    claudeModel: { get: mockClaudeModel },
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
// The default power-control opts every plain send carries ('default'/'' sentinels).
const NO_OPTS = { model: undefined, forceRoute: undefined }

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  mockAsk.mockReset()
  mockUndo.mockClear()
  mockNavigate.mockClear()
  mockWiCreate.mockReset()
  mockWiSetStatus.mockReset()
  mockFeed.mockResolvedValue(feedPayload)
  mockOrg.mockResolvedValue(orgPayload)
  mockStatus.mockResolvedValue(statusValue)
  mockNotes.mockResolvedValue(notesList)
  mockSchedule.mockResolvedValue(scheduleValue)
  mockThread.mockResolvedValue({ thread: threadValue, turns: threadTurns })
  mockWiList.mockResolvedValue(workItemsList)
  mockWiCreate.mockResolvedValue(workItemsList[0])
  mockWiSetStatus.mockResolvedValue(workItemsList[0])
  mockClaudeModel.mockResolvedValue({
    model: 'claude-sonnet-4-6',
    options: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ],
  })
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

  it('a forced route overrides the preview with routeForTarget\'s label and rides the send', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: FE_MSG } })

    // Classifier preview first (frontend for a react/css message)…
    expect(screen.getByTestId('khome-route-preview').textContent).toContain(routeForMessage(FE_MSG).label)

    // …then FORCE chief: the preview must show the forced label (routeForTarget —
    // the same mapping the server applies), not the classifier's guess.
    fireEvent.change(screen.getByTestId('khome-force-route'), { target: { value: 'chief' } })
    const preview = screen.getByTestId('khome-route-preview')
    expect(preview.textContent).toContain(routeForTarget('chief').label)
    expect(preview.textContent).toContain('Forced')

    fireEvent.click(screen.getByTestId('khome-send'))
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(FE_MSG, { model: undefined, forceRoute: 'chief' })
  })

  it('the model select lists the registry options and rides the send', async () => {
    renderHome()
    const select = (await screen.findByTestId('khome-model-select')) as HTMLSelectElement
    // 'default' + the two mocked registry options.
    await waitFor(() => expect(select.options.length).toBe(3))

    fireEvent.change(select, { target: { value: 'claude-opus-4-8' } })
    fireEvent.change(screen.getByTestId('khome-composer'), { target: { value: MSG } })
    fireEvent.click(screen.getByTestId('khome-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG, { model: 'claude-opus-4-8', forceRoute: undefined })
  })

  it('Send asks K once, stays on K-home (no navigation), and Undo undoes the run', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })

    fireEvent.click(screen.getByTestId('khome-send'))

    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1))
    expect(mockAsk).toHaveBeenCalledWith(MSG, NO_OPTS)

    // The undo toast raises IN PLACE — K-home must NOT auto-navigate to the run
    // (navigating would unmount the page and kill this very toast).
    const undo = await screen.findByTestId('khome-undo')
    expect(screen.getByTestId('khome-undo-toast')).toBeTruthy()
    expect(mockNavigate).not.toHaveBeenCalled()

    fireEvent.click(undo)
    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('run-123'))
    expect(mockUndo).toHaveBeenCalledTimes(1)
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
    expect(mockUndo).not.toHaveBeenCalled() // viewing ≠ undoing
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

      // Undo undoes run-2 ONLY (never the already-committed run-1).
      fireEvent.click(screen.getByTestId('khome-undo'))
      await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('run-2'))
      expect(mockUndo).toHaveBeenCalledTimes(1)
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
    // The window is raised optimistically at send (F-066); a failed dispatch tears it
    // back down — no lingering undo affordance (animations are instant here).
    await waitFor(() => expect(screen.queryByTestId('khome-undo-toast')).toBeNull())
    expect(mockUndo).not.toHaveBeenCalled()
  })

  // ── Conversation with K (the durable thread — F-077) ──────────────────────

  it('fetches the durable K thread and renders its turns as a conversation (F-077)', async () => {
    renderHome()
    const section = await screen.findByTestId('khome-thread')
    // Both the operator ask and K's reply render verbatim (the turns store real text,
    // not synthesized prompts) — so the durable conversation is reachable after reload.
    expect(await within(section).findByText('remind me to prep the notes')).toBeTruthy()
    expect(within(section).getByText(/Noted — I added a reminder/)).toBeTruthy()
    expect(mockThread).toHaveBeenCalled()
  })

  it('hides the conversation section when the thread has no turns, surfaces its error state', async () => {
    mockThread.mockResolvedValue({ thread: threadValue, turns: [] })
    renderHome()
    await screen.findByTestId('khome-greeting')
    expect(screen.queryByTestId('khome-thread')).toBeNull()
    cleanup()

    mockThread.mockRejectedValue(new Error('down'))
    renderHome()
    expect(await screen.findByTestId('khome-thread-error')).toBeTruthy()
  })

  it('Enter in the composer sends', async () => {
    renderHome()
    const input = screen.getByTestId('khome-composer') as HTMLInputElement
    fireEvent.change(input, { target: { value: MSG } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockAsk).toHaveBeenCalledWith(MSG, NO_OPTS))
  })

  // ── Your work (personal work items — C2) ──────────────────────────────────

  it('renders personal work items: checkbox state + a pill only for in-between statuses', async () => {
    renderHome()
    const section = await screen.findByTestId('khome-workitems')
    expect(await within(section).findByText('triage PR #42')).toBeTruthy()

    // open → unchecked, done → checked, blocked → unchecked + a status pill.
    expect((screen.getByTestId('khome-workitem-toggle-wi1') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('khome-workitem-toggle-wi2') as HTMLInputElement).checked).toBe(true)
    expect(within(screen.getByTestId('khome-workitem-wi3')).getByText('blocked')).toBeTruthy()
    // No pill for plain open/done rows.
    expect(within(screen.getByTestId('khome-workitem-wi1')).queryByText('open')).toBeNull()
  })

  it('toggling a work item PATCHes open↔done and refetches', async () => {
    renderHome()
    await screen.findByTestId('khome-workitem-wi1')

    fireEvent.click(screen.getByTestId('khome-workitem-toggle-wi1'))
    await waitFor(() => expect(mockWiSetStatus).toHaveBeenCalledWith('wi1', 'done'))

    fireEvent.click(screen.getByTestId('khome-workitem-toggle-wi2'))
    await waitFor(() => expect(mockWiSetStatus).toHaveBeenCalledWith('wi2', 'open'))
    // Invalidation refetched the list (initial load + one per successful toggle).
    await waitFor(() => expect(mockWiList.mock.calls.length).toBeGreaterThanOrEqual(3))
  })

  it('the add composer POSTs a new personal item and clears on success only', async () => {
    renderHome()
    const input = (await screen.findByTestId('khome-workitem-add-input')) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'water the plants' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockWiCreate).toHaveBeenCalledWith('water the plants'))
    await waitFor(() => expect(input.value).toBe(''))

    // A failed create keeps the typed title and surfaces the error inline.
    mockWiCreate.mockRejectedValueOnce(new Error('store down'))
    fireEvent.change(input, { target: { value: 'will fail' } })
    fireEvent.click(screen.getByTestId('khome-workitem-add'))
    await screen.findByTestId('khome-workitem-error')
    expect(screen.getByTestId('khome-workitem-error').textContent).toMatch(/store down/)
    expect(input.value).toBe('will fail')
  })

  it('work items: empty and error states', async () => {
    mockWiList.mockResolvedValue([])
    renderHome()
    const section = await screen.findByTestId('khome-workitems')
    expect(await within(section).findByText('No personal work items yet.')).toBeTruthy()
    cleanup()

    mockWiList.mockRejectedValue(new Error('down'))
    renderHome()
    expect(await screen.findByTestId('khome-workitems-error')).toBeTruthy()
  })

  // ── Notes + Schedule cards (C2) ───────────────────────────────────────────

  it('renders the notes card (done notes marked) and its empty state', async () => {
    renderHome()
    const notes = await screen.findByTestId('khome-notes')
    expect(await within(notes).findByText(/call re: API rate limits/)).toBeTruthy()
    // The done note renders with the ✓ marker.
    expect(within(notes).getByText(/idea: cache the graph layout/).textContent).toContain('✓')
    cleanup()

    mockNotes.mockResolvedValue([])
    renderHome()
    const empty = await screen.findByTestId('khome-notes')
    expect(await within(empty).findByText('No notes yet — ask K to take one.')).toBeTruthy()
  })

  it('renders the schedule card (event + overdue reminder) and its empty state', async () => {
    renderHome()
    const schedule = await screen.findByTestId('khome-schedule')
    expect(await within(schedule).findByText('design sync')).toBeTruthy()
    expect(within(schedule).getByText(/renew the domain/)).toBeTruthy()
    cleanup()

    mockSchedule.mockResolvedValue({ events: [], reminders: [] })
    renderHome()
    const empty = await screen.findByTestId('khome-schedule')
    expect(await within(empty).findByText('Nothing scheduled.')).toBeTruthy()
  })

  it('notes/schedule query failures render error states, not empty states', async () => {
    mockNotes.mockRejectedValue(new Error('down'))
    mockSchedule.mockRejectedValue(new Error('down'))
    renderHome()
    expect(await screen.findByTestId('khome-notes-error')).toBeTruthy()
    expect(await screen.findByTestId('khome-schedule-error')).toBeTruthy()
  })

  // ── Recent feed + degrades ────────────────────────────────────────────────

  it('renders the recent feed (from the shared feed key) and a row navigates to its run', async () => {
    renderHome()
    const section = await screen.findByTestId('khome-recent')
    // Wait for the feed query to populate the rows.
    expect(await within(section).findByText(/added focus ring/)).toBeTruthy()

    // A FeedRow is itself the clickable target now (no separate "View run" link) —
    // clicking the first row opens its run.
    const rows = within(section).getAllByTestId('feed-row')
    fireEvent.click(rows[0])
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-1')
  })

  it('a chief-org failure surfaces the glance error state (not fake zeros)', async () => {
    mockOrg.mockRejectedValue(new Error('org down'))
    renderHome()

    expect(await screen.findByTestId('khome-glance-error')).toBeTruthy()
    // The Chief link keeps working even while the glance is degraded.
    fireEvent.click(screen.getByTestId('khome-glance-link'))
    expect(mockNavigate).toHaveBeenCalledWith('chief')
  })

  it('a feed failure degrades the recent list to its empty state (feedQueryFn swallows errors — no error row)', async () => {
    mockFeed.mockRejectedValue(new Error('feed down'))
    renderHome()
    const section = await screen.findByTestId('khome-recent')
    expect(await within(section).findByText('No recent activity.')).toBeTruthy()
    // The error branch was removed with the runs query — there is never a khome-recent-error.
    expect(screen.queryByTestId('khome-recent-error')).toBeNull()
  })
})
