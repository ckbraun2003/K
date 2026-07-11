/**
 * P4 fix(p4-seams) M1 — the Run-tree picker updates the sub-agent tree IN PLACE and must
 * NOT navigate to #/runs/<id> (which RunsPage renders as the plain run console, unmounting
 * WorkflowsView). Renders the real WorkflowsView with the real `navigate`, so a regression
 * shows up as window.location.hash jumping to the console route.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run, WorkflowRun } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub (jsdom has no matchMedia; framer-motion probes it)
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

// Two workflow-dispatched runs so the picker populates WITHOUT toggling "All runs".
function run(id: string, prompt: string): Run {
  return { id, prompt, status: 'done', createdAt: 0, updatedAt: 0 } as unknown as Run
}
const RUNS = [run('run-1', 'first run'), run('run-2', 'second run')]

vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

vi.mock('../src/lib/api', () => ({
  api: {
    runs: {
      list: vi.fn(async () => RUNS),
      get: vi.fn(async (id: string) => RUNS.find(r => r.id === id) ?? RUNS[0]),
      events: vi.fn(async () => []),
      workflowSteps: vi.fn(async () => ({ workflowRun: null, steps: [] })),
    },
    workflows: {
      list: vi.fn(async () => []),
      // Both runs are workflow-dispatched → both appear in the default picker.
      runs: vi.fn(async () => [{ runId: 'run-1' }, { runId: 'run-2' }] as unknown as WorkflowRun[]),
    },
  },
}))

import WorkflowsView from '../src/pages/runs/WorkflowsView'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('Workflows Run-tree picker (M1)', () => {
  it('picking a run updates the tree in place without navigating to the run console', async () => {
    window.location.hash = '#/runs/workflows'
    renderWithQuery(<WorkflowsView />)

    // Switch to the Run tree tab.
    fireEvent.click(await screen.findByTestId('seg-run'))

    // Picker populates + auto-selects the first workflow run; its tree root renders.
    const picker = (await screen.findByLabelText('Run')) as HTMLSelectElement
    await waitFor(() => expect(picker.value).toBe('run-1'))
    expect(screen.getByTestId('run-tree-root')).toBeTruthy()

    // Pick the second run.
    fireEvent.change(picker, { target: { value: 'run-2' } })

    // In-place: the picker reflects the new run and the tree is still shown — but the hash
    // did NOT jump to the console route #/runs/run-2 (the pre-fix regression).
    await waitFor(() => expect(picker.value).toBe('run-2'))
    expect(screen.getByTestId('run-tree-root')).toBeTruthy()
    expect(window.location.hash).toBe('#/runs/workflows')
    expect(window.location.hash).not.toContain('run-2')
  })
})
