/**
 * WorkflowDetailPage — the "Run this workflow" launcher (C2). Gate assertions:
 *   - the header button opens the dialog; step 1 lists projects (empty state when
 *     none registered), step 2 lists ONLY the project's OPEN tasks
 *   - Run stays disabled until ≥1 task is checked, then dispatches with THIS
 *     workflow's id; success closes the dialog + raises the View-run toast
 *   - a dispatch failure surfaces INSIDE the dialog
 * api + route.navigate are mocked (vi.hoisted, mirroring chief-page.test.tsx).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { NamedWorkflow, Project, ProjectTask } from '@k/shared'

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

const detail: NamedWorkflow = {
  id: 'code-wave',
  name: 'Code wave',
  roles: [],
  promptScaffold: 'scaffold {{CHECKLIST}}',
  crossProject: false,
  createdAt: 0,
}

const project: Project = {
  id: 'proj-1', name: 'k', localPath: '/repo/k', githubRemote: undefined,
  workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0,
}

const tasks: ProjectTask[] = [
  { id: 't1', projectId: 'proj-1', title: 'open todo', status: 'open', createdAt: 0, completedAt: null },
  { id: 't2', projectId: 'proj-1', title: 'locked todo', status: 'in_progress', createdAt: 0, completedAt: null },
]

const { mockGet, mockProjects, mockTasks, mockDispatch, mockNavigate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProjects: vi.fn(),
  mockTasks: vi.fn(),
  mockDispatch: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    workflows: { get: mockGet, update: vi.fn() },
    projects: {
      list: mockProjects,
      tasks: { list: mockTasks, dispatchWorkflow: mockDispatch },
    },
  },
}))

vi.mock('../src/lib/route', () => ({
  navigate: mockNavigate,
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'workflow-detail' }),
}))

import WorkflowDetailPage from '../src/pages/WorkflowDetailPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkflowDetailPage id="code-wave" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockGet.mockReset()
  mockProjects.mockReset()
  mockTasks.mockReset()
  mockDispatch.mockReset()
  mockNavigate.mockClear()
  mockGet.mockResolvedValue(detail)
  mockProjects.mockResolvedValue([project])
  mockTasks.mockResolvedValue(tasks)
  mockDispatch.mockResolvedValue({ workflowRunId: 'wfr-1', runId: 'run-9' })
})
afterEach(() => cleanup())

async function openDialog() {
  renderPage()
  fireEvent.click(await screen.findByTestId('workflow-run-open'))
  return screen.findByTestId('workflow-run-dialog')
}

describe('WorkflowDetailPage — Run this workflow', () => {
  it('walks project → open tasks → dispatch with THIS workflow id, then toasts with a run link', async () => {
    const dialog = await openDialog()

    // Step 1: pick the project.
    const projectSelect = (await within(dialog).findByTestId('workflow-run-project')) as HTMLSelectElement
    await waitFor(() => expect(projectSelect.options.length).toBe(2)) // placeholder + proj-1
    fireEvent.change(projectSelect, { target: { value: 'proj-1' } })

    // Step 2: only the OPEN task is offered — the in_progress one is locked already.
    await within(dialog).findByTestId('workflow-run-task-t1')
    expect(within(dialog).queryByTestId('workflow-run-task-t2')).toBeNull()

    // Run is disabled until a task is checked.
    const fire = screen.getByTestId('workflow-run-fire') as HTMLButtonElement
    expect(fire.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('workflow-run-task-t1'))
    expect(fire.disabled).toBe(false)

    fireEvent.click(fire)
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith('proj-1', ['t1'], 'code-wave'))

    // Success: dialog closes, toast raises, View run navigates.
    await waitFor(() => expect(screen.queryByTestId('workflow-run-dialog')).toBeNull())
    await screen.findByTestId('workflow-run-toast')
    fireEvent.click(screen.getByTestId('workflow-run-view'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'run-9')
  })

  it('a dispatch failure surfaces inside the dialog (which stays open)', async () => {
    mockDispatch.mockRejectedValue(new Error('unknown workflow'))
    const dialog = await openDialog()

    const projectSelect = (await within(dialog).findByTestId('workflow-run-project')) as HTMLSelectElement
    await waitFor(() => expect(projectSelect.options.length).toBe(2))
    fireEvent.change(projectSelect, { target: { value: 'proj-1' } })
    fireEvent.click(await within(dialog).findByTestId('workflow-run-task-t1'))
    fireEvent.click(screen.getByTestId('workflow-run-fire'))

    const error = await screen.findByTestId('workflow-run-error')
    expect(error.textContent).toContain('unknown workflow')
    expect(screen.getByTestId('workflow-run-dialog')).toBeTruthy()
    expect(screen.queryByTestId('workflow-run-toast')).toBeNull()
  })

  it('shows the no-projects and no-open-tasks empty states', async () => {
    mockProjects.mockResolvedValue([])
    const dialog = await openDialog()
    expect(await within(dialog).findByText('No projects registered.')).toBeTruthy()
    cleanup()

    mockProjects.mockResolvedValue([project])
    mockTasks.mockResolvedValue([tasks[1]]) // only a locked task — nothing dispatchable
    const dialog2 = await openDialog()
    const projectSelect = (await within(dialog2).findByTestId('workflow-run-project')) as HTMLSelectElement
    await waitFor(() => expect(projectSelect.options.length).toBe(2))
    fireEvent.change(projectSelect, { target: { value: 'proj-1' } })
    expect(await within(dialog2).findByText('No open tasks in this project.')).toBeTruthy()
  })
})
