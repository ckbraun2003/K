/**
 * Named workflow definitions UI (P5.3b) — the roleChain helper, the Definitions list
 * (WorkflowsPage), and the WorkflowDetailPage editor. api is mocked so no network is
 * needed; renders wrap in a QueryClientProvider (retry off) like local-models.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { NamedWorkflow } from '@k/shared'

// jsdom has no matchMedia; framer-motion (Shell-adjacent) may probe it. Inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

afterEach(() => cleanup())

// ── fixtures + api mock ──────────────────────────────────────────────────────
function def(over: Partial<NamedWorkflow> = {}): NamedWorkflow {
  return {
    id: 'code-wave',
    name: 'Code wave',
    roles: [
      { id: 'orchestrator', label: 'Orchestrator', description: 'Owns the wave.' },
      { id: 'implementer', label: 'Implementer', description: 'Writes the change.' },
    ],
    promptScaffold: 'You are the orchestrator.\n{{CHECKLIST}}\nShip one commit.',
    crossProject: false,
    createdAt: 0,
    ...over,
  }
}

const listSpy = vi.fn(async () => [def(), def({ id: 'investigate', name: 'Investigate' })])
const getSpy = vi.fn(async () => def())
const updateSpy = vi.fn(async (_id: string, patch: Partial<NamedWorkflow>) => def(patch))

vi.mock('../src/lib/api', () => ({
  api: {
    workflows: {
      list: () => listSpy(),
      get: (_id: string) => getSpy(),
      update: (id: string, patch: Partial<NamedWorkflow>) => updateSpy(id, patch),
    },
    runs: { list: vi.fn(async () => []) },
  },
}))

import { roleChain } from '../src/pages/runs/WorkflowsView'
import WorkflowsView from '../src/pages/runs/WorkflowsView'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// ── roleChain (pure) ─────────────────────────────────────────────────────────
describe('roleChain', () => {
  it('joins role ids with an arrow', () => {
    expect(roleChain(def().roles)).toBe('orchestrator → implementer')
  })
  it('handles an empty role list', () => {
    expect(roleChain([])).toBe('')
  })
})

// ── Definitions list (WorkflowsPage, defined tab) ────────────────────────────
describe('WorkflowsPage — Definitions list', () => {
  it('renders a row per definition and its role chain', async () => {
    renderWithQuery(<WorkflowsView />)
    await waitFor(() => expect(screen.getByTestId('workflow-def-row-code-wave')).toBeTruthy())
    expect(screen.getByTestId('workflow-def-row-investigate')).toBeTruthy()
    expect(screen.getByTestId('workflow-def-row-code-wave').textContent).toContain('orchestrator → implementer')
  })

  it('Open navigates to the workflow-detail route for the selected def', async () => {
    renderWithQuery(<WorkflowsView />)
    await waitFor(() => expect(screen.getByTestId('workflow-def-open')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workflow-def-open'))
    expect(window.location.hash).toContain('runs/workflows/code-wave')
  })
})

// ── WorkflowDetailPage editor ────────────────────────────────────────────────
describe('WorkflowDetailPage', () => {
  it('seeds the scaffold editor from the loaded definition', async () => {
    renderWithQuery(<WorkflowsView defId="code-wave" />)
    // Wait for the SEEDED VALUE, not just the textarea's existence: the editor is
    // populated by an effect after the definition query resolves, so an existence
    // wait + a synchronous .value check races the seeding (passes on a fast worktree,
    // fails under load in the main tree). Assert the value inside waitFor.
    await waitFor(() =>
      expect((screen.getByTestId('workflow-detail-scaffold') as HTMLTextAreaElement).value).toContain('{{CHECKLIST}}'),
    )
  })

  it('saves an edited scaffold via api.workflows.update', async () => {
    renderWithQuery(<WorkflowsView defId="code-wave" />)
    const ta = await screen.findByTestId('workflow-detail-scaffold')
    fireEvent.change(ta, { target: { value: 'new scaffold {{CHECKLIST}}' } })
    fireEvent.click(screen.getByTestId('workflow-detail-save'))
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('code-wave', { promptScaffold: 'new scaffold {{CHECKLIST}}' }),
    )
  })

  it('toggles the cross-project flag via api.workflows.update', async () => {
    renderWithQuery(<WorkflowsView defId="code-wave" />)
    const toggle = await screen.findByTestId('workflow-detail-crossproject')
    fireEvent.click(toggle)
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('code-wave', { crossProject: true }))
  })

  // Folded (P4 C1): WorkflowsView with no defId is the LIST, so the editor's
  // NotFound is now reachable only via a defId whose fetch fails (isError branch).
  it('shows NotFound when the workflow fails to load', async () => {
    getSpy.mockRejectedValueOnce(new Error('no such workflow'))
    renderWithQuery(<WorkflowsView defId="ghost" />)
    await waitFor(() => expect(screen.getByTestId('workflow-detail-notfound')).toBeTruthy())
  })
})
