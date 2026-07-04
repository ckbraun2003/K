/**
 * TasksTab — Wave 4 behavioral fixes:
 *   F-040: the per-row "▶ Dispatch agent" is a PAID run, so it must confirm first —
 *          the mutation fires only after confirming the dialog, never on the bare click.
 *   F-041: a rapid double-submit of "Add" creates ONE task (in-flight guard), not two.
 *   F-045: "Sync with GitHub Issues" surfaces a result ("Synced N issues" / "No new issues").
 * api + route.navigate are mocked (vi.hoisted, mirroring chief-page.test.tsx).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProjectTask } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

function task(id: string, over: Partial<ProjectTask> = {}): ProjectTask {
  return { id, projectId: 'p1', title: `task ${id}`, status: 'open', createdAt: 0, ...over }
}

const { mockList, mockCreate, mockSync, mockStart, mockUpdate, mockDelete, mockDispatchWorkflow, mockNavigate } =
  vi.hoisted(() => ({
    mockList: vi.fn(),
    mockCreate: vi.fn(),
    mockSync: vi.fn(),
    mockStart: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockDispatchWorkflow: vi.fn(),
    mockNavigate: vi.fn(),
  }))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: {
      tasks: {
        list: mockList,
        create: mockCreate,
        sync: mockSync,
        updateStatus: mockUpdate,
        delete: mockDelete,
        dispatchWorkflow: mockDispatchWorkflow,
      },
    },
    runs: { start: mockStart },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import TasksTab from '../src/pages/tabs/TasksTab'

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TasksTab projectId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockList.mockReset(); mockCreate.mockReset(); mockSync.mockReset(); mockStart.mockReset()
  mockUpdate.mockReset(); mockDelete.mockReset(); mockDispatchWorkflow.mockReset(); mockNavigate.mockClear()
  mockList.mockResolvedValue([task('t1')])
  mockCreate.mockResolvedValue(task('t2', { title: 'new' }))
  mockStart.mockResolvedValue({ id: 'run-1' })
})
afterEach(() => cleanup())

describe('TasksTab — F-040 dispatch confirmation', () => {
  it('clicking Dispatch shows a confirm and does NOT fire the paid run until confirmed', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('task-dispatch-btn-t1'))

    // Confirm dialog appears; the mutation has NOT fired yet.
    await screen.findByTestId('task-dispatch')
    expect(mockStart).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('task-dispatch-confirm'))
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    expect(mockStart).toHaveBeenCalledWith('task t1', { projectId: 'p1' })
  })

  it('cancelling the dispatch confirm never fires the run', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('task-dispatch-btn-t1'))
    fireEvent.click(await screen.findByTestId('task-dispatch-cancel'))
    await waitFor(() => expect(screen.queryByTestId('task-dispatch')).toBeNull())
    expect(mockStart).not.toHaveBeenCalled()
  })
})

describe('TasksTab — F-041 double-add guard', () => {
  it('a rapid double-submit of Add creates exactly one task', async () => {
    // Hold the create promise open so the second click lands while the first is in flight.
    let settle!: (t: ProjectTask) => void
    mockCreate.mockReturnValue(new Promise<ProjectTask>(res => { settle = res }))
    renderTab()
    await screen.findByTestId('task-dispatch-btn-t1') // list loaded

    const input = screen.getByPlaceholderText('New task title…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'dup me' } })
    const addBtn = screen.getByText('Add')
    // Two synchronous clicks: the ref guard blocks the second before react-query's
    // isPending re-render could (proving the guard, not just the disabled attr).
    fireEvent.click(addBtn)
    fireEvent.click(addBtn)

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    // Let any erroneous second call flush; it must still be exactly one.
    await Promise.resolve()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    settle(task('t9', { title: 'dup me' }))
  })
})

describe('TasksTab — F-045 sync feedback', () => {
  it('renders "Synced N issues" after a successful non-degraded sync', async () => {
    mockSync.mockResolvedValue({ synced: 3, degraded: false })
    renderTab()
    fireEvent.click(await screen.findByText('Sync with GitHub Issues'))
    const result = await screen.findByTestId('tasks-sync-result')
    expect(result.textContent).toContain('Synced 3 issues')
  })

  it('renders "No new issues" when the sync returns 0', async () => {
    mockSync.mockResolvedValue({ synced: 0, degraded: false })
    renderTab()
    fireEvent.click(await screen.findByText('Sync with GitHub Issues'))
    const result = await screen.findByTestId('tasks-sync-result')
    expect(result.textContent).toContain('No new issues')
  })
})
