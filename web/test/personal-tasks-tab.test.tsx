/**
 * TasksTab (Personal hub, UI Simplification Task 14) — the full personal work-item
 * management surface, ported from KHome's "Your work"/Notes/Schedule cards
 * (KHome.tsx:296-423). Gate assertions:
 *   - personal work items render by default (both-scope list filtered client-side)
 *   - the Personal/Org SegControl switches the filtered scope
 *   - checkbox toggle PATCHes via api.k.workItems.setStatus
 *   - the add-input Enter key POSTs via api.k.workItems.create
 *   - Notes + Schedule cards render their mocked rows (ported assertion style from
 *     khome.test.tsx's Notes/Schedule cases)
 *   - empty and error states for work items / notes / schedule
 * api is mocked (vi.hoisted, mirroring khome.test.tsx).
 *
 * NOTE: this file is named personal-tasks-tab.test.tsx, not tasks-tab.test.tsx —
 * web/test/tasks-tab.test.tsx already exists and covers the UNRELATED
 * src/pages/tabs/TasksTab.tsx (the per-project workspace Tasks tab, GitHub-issue
 * sync + dispatch). Reusing that filename would have overwritten a live test file
 * for a different component (test/ is a flat directory, so the two `TasksTab`
 * components collide only on the test filename, not on any source path or import).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Note, KSchedule, WorkItem } from '@k/shared'

const { mockWiList, mockWiCreate, mockWiSetStatus, mockNotes, mockSchedule } = vi.hoisted(() => ({
  mockWiList: vi.fn(),
  mockWiCreate: vi.fn(),
  mockWiSetStatus: vi.fn(),
  mockNotes: vi.fn(),
  mockSchedule: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    k: {
      workItems: { list: mockWiList, create: mockWiCreate, setStatus: mockWiSetStatus },
      notes: mockNotes,
      schedule: mockSchedule,
    },
  },
}))

import TasksTab from '../src/pages/personal/TasksTab'

const workItemsList: WorkItem[] = [
  { id: 'wi1', runId: null, title: 'triage PR #42', body: null, status: 'open', scope: 'personal', createdAt: 1, updatedAt: 1 },
  { id: 'wi2', runId: null, title: 'build graph', body: null, status: 'done', scope: 'personal', createdAt: 2, updatedAt: 2 },
  { id: 'wi3', runId: null, title: 'org standup notes', body: null, status: 'blocked', scope: 'org', createdAt: 3, updatedAt: 3 },
]

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

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TasksTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockWiList.mockReset(); mockWiCreate.mockReset(); mockWiSetStatus.mockReset()
  mockNotes.mockReset(); mockSchedule.mockReset()
  mockWiList.mockResolvedValue(workItemsList)
  mockWiCreate.mockResolvedValue(workItemsList[0])
  mockWiSetStatus.mockResolvedValue(workItemsList[0])
  mockNotes.mockResolvedValue(notesList)
  mockSchedule.mockResolvedValue(scheduleValue)
})
afterEach(() => cleanup())

describe('TasksTab — work items (personal/org scope)', () => {
  it('fetches the unscoped list and defaults to showing personal items only', async () => {
    renderTab()
    const section = await screen.findByTestId('tasks-workitems')
    expect(await within(section).findByText('triage PR #42')).toBeTruthy()
    expect(within(section).getByText('build graph')).toBeTruthy()
    expect(within(section).queryByText('org standup notes')).toBeNull()
    // Unscoped: no query-string arg passed to the API.
    expect(mockWiList).toHaveBeenCalledWith()
  })

  it('the Org SegControl option switches the filtered scope', async () => {
    renderTab()
    await screen.findByText('triage PR #42')

    fireEvent.click(screen.getByTestId('seg-org'))
    expect(await screen.findByText('org standup notes')).toBeTruthy()
    expect(screen.queryByText('triage PR #42')).toBeNull()
  })

  it('checkbox toggle PATCHes open<->done via setStatus', async () => {
    renderTab()
    await screen.findByTestId('tasks-workitem-wi1')

    fireEvent.click(screen.getByTestId('tasks-workitem-toggle-wi1'))
    await waitFor(() => expect(mockWiSetStatus).toHaveBeenCalledWith('wi1', 'done'))

    fireEvent.click(screen.getByTestId('tasks-workitem-toggle-wi2'))
    await waitFor(() => expect(mockWiSetStatus).toHaveBeenCalledWith('wi2', 'open'))
  })

  it('renders a status pill for in-between statuses, not for plain open/done', async () => {
    renderTab()
    await screen.findByTestId('tasks-workitem-wi1')
    fireEvent.click(screen.getByTestId('seg-org'))
    expect(within(await screen.findByTestId('tasks-workitem-wi3')).getByText('blocked')).toBeTruthy()
  })

  it('the add-input Enter key POSTs a new personal item and clears on success', async () => {
    renderTab()
    const input = (await screen.findByTestId('tasks-workitem-add-input')) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'water the plants' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockWiCreate).toHaveBeenCalledWith('water the plants'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('a failed create keeps the typed title and surfaces the error inline', async () => {
    renderTab()
    const input = (await screen.findByTestId('tasks-workitem-add-input')) as HTMLInputElement
    mockWiCreate.mockRejectedValueOnce(new Error('store down'))
    fireEvent.change(input, { target: { value: 'will fail' } })
    fireEvent.click(screen.getByTestId('tasks-workitem-add'))
    await screen.findByTestId('tasks-workitem-error')
    expect(screen.getByTestId('tasks-workitem-error').textContent).toMatch(/store down/)
    expect(input.value).toBe('will fail')
  })

  it('work items: empty and error states', async () => {
    mockWiList.mockResolvedValue([])
    renderTab()
    const section = await screen.findByTestId('tasks-workitems')
    expect(await within(section).findByText('No personal work items yet.')).toBeTruthy()
    cleanup()

    mockWiList.mockRejectedValue(new Error('down'))
    renderTab()
    expect(await screen.findByTestId('tasks-workitems-error')).toBeTruthy()
  })
})

describe('TasksTab — Notes + Schedule cards', () => {
  it('renders the notes card (done notes marked) and its empty state', async () => {
    renderTab()
    const notes = await screen.findByTestId('tasks-notes')
    expect(await within(notes).findByText(/call re: API rate limits/)).toBeTruthy()
    expect(within(notes).getByText(/idea: cache the graph layout/).textContent).toContain('✓')
    cleanup()

    mockNotes.mockResolvedValue([])
    renderTab()
    const empty = await screen.findByTestId('tasks-notes')
    expect(await within(empty).findByText('No notes yet — ask K to take one.')).toBeTruthy()
  })

  it('renders the schedule card (event + overdue reminder) and its empty state', async () => {
    renderTab()
    const schedule = await screen.findByTestId('tasks-schedule')
    expect(await within(schedule).findByText('design sync')).toBeTruthy()
    expect(within(schedule).getByText(/renew the domain/)).toBeTruthy()
    cleanup()

    mockSchedule.mockResolvedValue({ events: [], reminders: [] })
    renderTab()
    const empty = await screen.findByTestId('tasks-schedule')
    expect(await within(empty).findByText('Nothing scheduled.')).toBeTruthy()
  })

  it('notes/schedule query failures render error states, not empty states', async () => {
    mockNotes.mockRejectedValue(new Error('down'))
    mockSchedule.mockRejectedValue(new Error('down'))
    renderTab()
    expect(await screen.findByTestId('tasks-notes-error')).toBeTruthy()
    expect(await screen.findByTestId('tasks-schedule-error')).toBeTruthy()
  })
})
