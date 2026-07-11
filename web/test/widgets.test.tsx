/**
 * Widget catalog (UI Simplification Task 13) — one thin, mocked-api render
 * block per real widget body, plus a compile/coverage check that WIDGET_DEFS
 * (widgets/index.tsx) addresses every HomeWidgetId. Each widget ports an
 * existing KHome/ActivityStrip/InboxPage/ProjectCard surface onto a SHARED
 * query key (see each widget file's header comment) — these tests exercise
 * that ported behavior (empty/loaded/error rendering + navigation), not the
 * underlying shared query modules themselves (those have their own tests:
 * runs-query, inbox-query, feed-query, live-invalidate).
 *
 * api + route.navigate are mocked at the same seam every other page test
 * uses (mirrors khome.test.tsx / overview-view.test.tsx) — no real network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import {
  HomeWidgetIdSchema,
  type Run, type InboxPayload, type ChiefOrgPayload, type FeedItem, type FeedPayload,
  type CostRollup, type WorkItem, type Note, type KSchedule, type Project,
} from '@k/shared'
import { runStatusMeta } from '../src/lib/status'
import { healthRubric } from '../src/lib/health'

const {
  mockRunsList, mockInboxList, mockOrg, mockFeedList, mockCostRollup,
  mockNotes, mockSchedule, mockWiList, mockWiCreate, mockWiSetStatus,
  mockProjectsList, mockNavigate,
} = vi.hoisted(() => ({
  mockRunsList: vi.fn(),
  mockInboxList: vi.fn(),
  mockOrg: vi.fn(),
  mockFeedList: vi.fn(),
  mockCostRollup: vi.fn(),
  mockNotes: vi.fn(),
  mockSchedule: vi.fn(),
  mockWiList: vi.fn(),
  mockWiCreate: vi.fn(),
  mockWiSetStatus: vi.fn(),
  mockProjectsList: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: { list: mockRunsList },
    inbox: { list: mockInboxList },
    chief: { org: mockOrg },
    feed: { list: mockFeedList },
    metrics: { costRollup: mockCostRollup },
    k: {
      notes: mockNotes,
      schedule: mockSchedule,
      workItems: { list: mockWiList, create: mockWiCreate, setStatus: mockWiSetStatus },
    },
    projects: { list: mockProjectsList },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
}))

import { WIDGET_DEFS } from '../src/pages/home/widgets'
import ActiveRunsWidget from '../src/pages/home/widgets/ActiveRunsWidget'
import NeedsYouWidget from '../src/pages/home/widgets/NeedsYouWidget'
import OrgGlanceWidget from '../src/pages/home/widgets/OrgGlanceWidget'
import RecentActivityWidget from '../src/pages/home/widgets/RecentActivityWidget'
import CostTodayWidget from '../src/pages/home/widgets/CostTodayWidget'
import PersonalTasksWidget from '../src/pages/home/widgets/PersonalTasksWidget'
import NotesWidget from '../src/pages/home/widgets/NotesWidget'
import ScheduleWidget from '../src/pages/home/widgets/ScheduleWidget'
import ProjectHealthWidget from '../src/pages/home/widgets/ProjectHealthWidget'

function renderWidget(el: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>)
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const RUN_PARKED: Run = {
  id: 'run-parked', prompt: 'waiting on your reply', cwd: '/x', status: 'awaiting_input',
  provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1,
}
const RUN_RUNNING: Run = {
  id: 'run-active', prompt: 'refactor the auth module', cwd: '/x', status: 'running',
  provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 2,
}

const orgPayload: ChiefOrgPayload = {
  chief: null, leads: [], chiefWakes: [],
  assignments: [
    { id: 'a1', runId: null, lead: 'FE', objective: 'ship it', note: null, workflow: null, projects: [], leadRunId: null, createdAt: 1, updatedAt: 1 },
  ],
  health: { leadsActive: 2 },
}

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

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10)
}

beforeEach(() => {
  mockRunsList.mockReset().mockResolvedValue([])
  mockInboxList.mockReset().mockResolvedValue({ items: [], counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0 }, total: 0 } satisfies InboxPayload)
  mockOrg.mockReset().mockResolvedValue(orgPayload)
  mockFeedList.mockReset().mockResolvedValue(feedPayload)
  mockCostRollup.mockReset().mockResolvedValue({ windowDays: 14, groupBy: 'day', totalCostUsd: 0, buckets: [] } satisfies CostRollup)
  mockNotes.mockReset().mockResolvedValue(notesList)
  mockSchedule.mockReset().mockResolvedValue(scheduleValue)
  mockWiList.mockReset().mockResolvedValue([])
  mockWiCreate.mockReset()
  mockWiSetStatus.mockReset()
  mockProjectsList.mockReset().mockResolvedValue([])
  mockNavigate.mockClear()
})
afterEach(() => cleanup())

describe('widget catalog', () => {
  it('WIDGET_DEFS covers every HomeWidgetId', () => {
    expect(Object.keys(WIDGET_DEFS).sort()).toEqual([...HomeWidgetIdSchema.options].sort())
  })

  it('ActiveRunsWidget: active green / parked amber rows; row click navigates to the run', async () => {
    mockRunsList.mockResolvedValue([RUN_RUNNING, RUN_PARKED])
    renderWidget(<ActiveRunsWidget />)

    const rows = await screen.findAllByTestId('widget-active-runs-row')
    expect(rows).toHaveLength(2)

    // Parked (awaiting input) sorts before active (running).
    const parkedMeta = runStatusMeta('awaiting_input')
    const runningMeta = runStatusMeta('running')
    expect(rows[0].children[0].className).toContain(parkedMeta.dot)
    expect(rows[0].children[2].textContent).toBe(parkedMeta.label)
    expect(rows[1].children[0].className).toContain(runningMeta.dot)
    expect(rows[1].children[2].textContent).toBe(runningMeta.label)
    // The two statuses must render visibly different dot colors (E-11 meta), not the same class.
    expect(parkedMeta.dot).not.toBe(runningMeta.dot)

    fireEvent.click(rows[0])
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-parked')
    fireEvent.click(rows[1])
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-active')
  })

  it('ActiveRunsWidget: renders an idle empty state without crashing', async () => {
    mockRunsList.mockResolvedValue([])
    renderWidget(<ActiveRunsWidget />)
    expect(await screen.findByText(/Idle/)).toBeTruthy()
  })

  it('NeedsYouWidget: renders per-kind counts; click navigates to personal/inbox', async () => {
    mockInboxList.mockResolvedValue({
      items: [],
      counts: { plan_pending: 2, input_needed: 1, lesson_pending: 0, mcp_trust: 0, review_ready: 3 },
      total: 6,
    } satisfies InboxPayload)
    renderWidget(<NeedsYouWidget />)

    const widget = await screen.findByTestId('widget-needs-you')
    await waitFor(() => expect(within(widget).getByText('6')).toBeTruthy())
    expect(screen.getByTestId('widget-needs-you-chip-plan_pending').textContent).toContain('2')
    expect(screen.getByTestId('widget-needs-you-chip-input_needed').textContent).toContain('1')
    expect(screen.getByTestId('widget-needs-you-chip-review_ready').textContent).toContain('3')
    // Zero-count kinds render no chip.
    expect(screen.queryByTestId('widget-needs-you-chip-lesson_pending')).toBeNull()
    expect(screen.queryByTestId('widget-needs-you-chip-mcp_trust')).toBeNull()

    fireEvent.click(widget)
    expect(mockNavigate).toHaveBeenCalledWith('personal', 'inbox')
  })

  it('NeedsYouWidget: renders "Inbox zero." when the inbox is empty', async () => {
    renderWidget(<NeedsYouWidget />)
    expect(await screen.findByText('Inbox zero.')).toBeTruthy()
  })

  it('CostTodayWidget: renders todays measured total + sparkline; NO "$/token" or "est" strings', async () => {
    // Collapse MetricCard's useTicker rAF animation to a single synchronous frame
    // (it interpolates the headline number over a real 400ms window) so the test
    // asserts CostTodayWidget's own bucket-selection logic, not animation timing.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 1_000)
      return 0
    })
    const today = todayUtcKey()
    mockCostRollup.mockResolvedValue({
      windowDays: 14, groupBy: 'day', totalCostUsd: 5,
      buckets: [
        { key: today, label: 'today', costUsd: 2, runs: 3 },
        { key: '2024-01-01', label: 'earlier', costUsd: 3, runs: 1 },
      ],
    } satisfies CostRollup)

    const { container } = renderWidget(<CostTodayWidget />)
    const widget = await screen.findByTestId('widget-cost-today')
    await waitFor(() => expect(widget.textContent).toMatch(/\$2\b/))
    expect(mockCostRollup).toHaveBeenCalledWith({ days: 14, groupBy: 'day' })

    const text = (container.textContent ?? '').toLowerCase()
    expect(text).not.toContain('$/token')
    expect(text).not.toContain('est')
    // The 14-day sparkline (Sparkline renders a bare <svg> even with 1 point, and a
    // polyline once there are 2+ points — this fixture has 2 buckets).
    expect(container.querySelectorAll('svg polyline').length).toBeGreaterThan(0)
  })

  it('CostTodayWidget: with no matching bucket for today, headline reads $0 (never a borrowed days total)', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 1_000)
      return 0
    })
    mockCostRollup.mockResolvedValue({
      windowDays: 14, groupBy: 'day', totalCostUsd: 3,
      buckets: [{ key: '2024-01-01', label: 'earlier', costUsd: 3, runs: 1 }],
    } satisfies CostRollup)
    renderWidget(<CostTodayWidget />)
    const widget = await screen.findByTestId('widget-cost-today')
    await waitFor(() => expect(widget.textContent).toMatch(/\$0\b/))
  })

  it('CostTodayWidget: a cost-rollup fetch failure surfaces the error state, never a fake $0', async () => {
    mockCostRollup.mockRejectedValue(new Error('rollup down'))
    const { container } = renderWidget(<CostTodayWidget />)
    expect(await screen.findByTestId('widget-cost-today-error')).toBeTruthy()
    // A failed fetch must be visually distinguishable from an honest zero-spend
    // day (D-026): no dollar figure at all, not a fabricated $0.0000.
    expect(container.textContent).not.toMatch(/\$/)
  })

  it('PersonalTasksWidget: add + toggle call api.k.workItems', async () => {
    mockWiList.mockResolvedValue([
      { id: 'wi1', runId: null, title: 'triage PR #42', body: null, status: 'open', scope: 'personal', createdAt: 1, updatedAt: 1 },
    ] satisfies WorkItem[])
    mockWiSetStatus.mockResolvedValue({})
    mockWiCreate.mockResolvedValue({})
    renderWidget(<PersonalTasksWidget />)

    await screen.findByTestId('widget-personal-tasks-toggle-wi1')
    fireEvent.click(screen.getByTestId('widget-personal-tasks-toggle-wi1'))
    await waitFor(() => expect(mockWiSetStatus).toHaveBeenCalledWith('wi1', 'done'))

    const input = screen.getByTestId('widget-personal-tasks-add-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'water the plants' } })
    fireEvent.click(screen.getByTestId('widget-personal-tasks-add'))
    await waitFor(() => expect(mockWiCreate).toHaveBeenCalledWith('water the plants'))
  })

  it('PersonalTasksWidget: renders an empty state without crashing', async () => {
    renderWidget(<PersonalTasksWidget />)
    expect(await screen.findByText('No personal work items yet.')).toBeTruthy()
  })

  it('ProjectHealthWidget: renders one dot per project with healthRubric band', async () => {
    const projects: Project[] = [
      { id: 'p1', name: 'healthy-proj', localPath: '/x', workspaceManaged: false, bibleDir: 'docs/bible', healthScore: 90, createdAt: 1 },
      { id: 'p2', name: 'warn-proj', localPath: '/y', workspaceManaged: false, bibleDir: 'docs/bible', healthScore: 60, createdAt: 2 },
      { id: 'p3', name: 'critical-proj', localPath: '/z', workspaceManaged: false, bibleDir: 'docs/bible', healthScore: 20, createdAt: 3 },
    ]
    mockProjectsList.mockResolvedValue(projects)
    renderWidget(<ProjectHealthWidget />)

    expect(await screen.findByTestId('widget-project-health-dot-p1')).toBeTruthy()
    // Each row renders the CANONICAL <HealthRubric> component (data-testid
    // "health-rubric", dot = its first inner span), not hand-rolled spans.
    const dotClass = (id: string) => within(screen.getByTestId(`widget-project-health-dot-${id}`))
      .getByTestId('health-rubric').querySelector('span')!.className
    expect(dotClass('p1')).toContain(healthRubric(90).dot)
    expect(dotClass('p2')).toContain(healthRubric(60).dot)
    expect(dotClass('p3')).toContain(healthRubric(20).dot)
    // The three bands must actually differ in color (never a flat/uniform dot).
    expect(healthRubric(90).dot).not.toBe(healthRubric(60).dot)
    expect(healthRubric(60).dot).not.toBe(healthRubric(20).dot)

    fireEvent.click(screen.getByTestId('widget-project-health-row-p1'))
    expect(mockNavigate).toHaveBeenCalledWith('project', 'p1')
  })

  it('ProjectHealthWidget: a project with no health score renders the "unknown" band, not a crash', async () => {
    mockProjectsList.mockResolvedValue([
      { id: 'p1', name: 'unscored', localPath: '/x', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 1 },
    ] satisfies Project[])
    renderWidget(<ProjectHealthWidget />)
    expect(await screen.findByTestId('widget-project-health-dot-p1')).toBeTruthy()
    const rubric = within(screen.getByTestId('widget-project-health-dot-p1')).getByTestId('health-rubric')
    expect(rubric.querySelector('span')!.className).toContain(healthRubric(null).dot)
  })

  // ── Thin render-smoke coverage for the remaining widgets ──────────────────

  it('OrgGlanceWidget: renders leads/objectives and navigates to the org tree', async () => {
    renderWidget(<OrgGlanceWidget />)
    const widget = await screen.findByTestId('widget-org-glance')
    await waitFor(() => expect(widget.textContent).toMatch(/2/))
    expect(widget.textContent).toMatch(/1/) // 1 objective in flight (orgPayload.assignments)
    fireEvent.click(widget)
    expect(mockNavigate).toHaveBeenCalledWith('org', 'tree')
  })

  it('OrgGlanceWidget: a chief-org failure surfaces the error state, not fake zeros', async () => {
    mockOrg.mockRejectedValue(new Error('org down'))
    renderWidget(<OrgGlanceWidget />)
    expect(await screen.findByTestId('widget-org-glance-error')).toBeTruthy()
  })

  it('RecentActivityWidget: renders feed rows; See all navigates to the timeline', async () => {
    renderWidget(<RecentActivityWidget />)
    expect(await screen.findAllByTestId('feed-row')).toHaveLength(2)
    expect(mockFeedList).toHaveBeenCalledWith({ limit: 6 })
    fireEvent.click(screen.getByTestId('widget-recent-activity-seeall'))
    expect(mockNavigate).toHaveBeenCalledWith('timeline')
  })

  it('NotesWidget: renders notes with the done marker and its empty state', async () => {
    renderWidget(<NotesWidget />)
    expect(await screen.findByText(/call re: API rate limits/)).toBeTruthy()
    expect(screen.getByText(/idea: cache the graph layout/).textContent).toContain('✓')
    cleanup()

    mockNotes.mockResolvedValue([])
    renderWidget(<NotesWidget />)
    expect(await screen.findByText('No notes yet — ask K to take one.')).toBeTruthy()
  })

  it('ScheduleWidget: renders events and tints overdue reminders red', async () => {
    renderWidget(<ScheduleWidget />)
    expect(await screen.findByText('design sync')).toBeTruthy()
    const reminder = screen.getByText(/renew the domain/)
    expect(reminder.className).toContain('text-[var(--red)]')
  })
})
