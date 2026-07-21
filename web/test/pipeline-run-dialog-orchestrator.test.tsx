/**
 * PipelineLibraryPane's "Run pipeline" launcher — "Observed by" picker (Lane B,
 * ui-adjustments Round 2, seam w/ Lane C). The picker lists chief- and
 * orchestrator-tier profiles (api.profiles.list, not api.orchestrators.list —
 * that server-filters to the 5 discipline leads only, excluding Chief-tier
 * domain managers). Left at "Auto", the dispatch omits `orchestratorId` entirely
 * so the SERVER resolves the default (the pipeline definition's domain manager,
 * else null) — see core/test/pipelines-routes.test.ts for that half. Picking a
 * profile threads its id straight through to `api.pipelines.run`.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentProfile, PipelineDefSummary, Project } from '@k/shared'

const { mockList, mockRun, mockProfilesList, mockProjectsList } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockRun: vi.fn(),
  mockProfilesList: vi.fn(),
  mockProjectsList: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    pipelines: { list: mockList, run: mockRun },
    profiles: { list: mockProfilesList },
    projects: { list: mockProjectsList },
  },
}))

import { PipelineLibraryPane } from '../src/pages/runs/PipelinesView'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => { cleanup(); mockList.mockReset(); mockRun.mockReset(); mockProfilesList.mockReset(); mockProjectsList.mockReset() })

const DEF: PipelineDefSummary = { id: 'def-1', name: 'Ship it', description: null, hasSpec: true }

function profile(over: Partial<AgentProfile>): AgentProfile {
  return {
    id: over.id ?? 'p', name: over.name ?? 'Profile', tier: over.tier ?? 'orchestrator',
    charter: over.charter ?? 'orchestrator', defaultModel: null, allowedTools: [], mcpServers: [], skills: [],
    ...over,
  }
}

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PipelineLibraryPane onDispatched={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('RunPipelineDialog "Observed by" picker (Lane B, ui-adjustments Round 2)', () => {
  it('lists chief + orchestrator tier profiles, excluding secretary-tier', async () => {
    mockList.mockResolvedValue([DEF])
    mockProjectsList.mockResolvedValue([] as Project[])
    mockProfilesList.mockResolvedValue([
      profile({ id: 'k-secretary', name: 'K', tier: 'secretary' }),
      profile({ id: 'chief-1', name: 'Chief', tier: 'chief', charter: 'chief' }),
      profile({ id: 'lead-frontend', name: 'Frontend Lead', tier: 'orchestrator' }),
    ])

    renderPane()
    // The "Run pipeline" button stays disabled until the defs list resolves —
    // wait for a def row so the click below actually lands.
    await screen.findByTestId('pipeline-def-def-1')
    fireEvent.click(screen.getByTestId('pipeline-run-open'))
    const select = await screen.findByTestId('pipeline-run-orchestrator')
    // The profiles query resolves async (same tick as the dialog mount) — wait
    // for its options rather than asserting on the very first paint.
    await waitFor(() => expect(select.textContent).toContain('Chief'))
    expect(select.textContent).toContain('Frontend Lead')
    expect(select.textContent).not.toContain('K')
  })

  it('left on "Auto" — dispatch omits orchestratorId entirely', async () => {
    mockList.mockResolvedValue([DEF])
    mockProjectsList.mockResolvedValue([] as Project[])
    mockProfilesList.mockResolvedValue([profile({ id: 'chief-1', name: 'Chief', tier: 'chief', charter: 'chief' })])
    mockRun.mockResolvedValue({ pipelineRunId: 'run-1' })

    renderPane()
    await screen.findByTestId('pipeline-def-def-1')
    fireEvent.click(screen.getByTestId('pipeline-run-open'))
    await screen.findByTestId('pipeline-run-orchestrator')
    fireEvent.change(screen.getByTestId('pipeline-run-goal'), { target: { value: 'go' } })

    fireEvent.click(screen.getByTestId('pipeline-run-fire'))
    await waitFor(() => expect(mockRun).toHaveBeenCalled())
    const [, body] = mockRun.mock.calls[0]
    // orchestratorId is `orchestratorId || undefined` — the key is present but
    // its VALUE must be undefined so JSON.stringify (the real fetch body) drops
    // it entirely, matching the "omit when Auto" contract.
    expect(body.orchestratorId).toBeUndefined()
  })

  it('picking a profile threads its id into the dispatch body', async () => {
    mockList.mockResolvedValue([DEF])
    mockProjectsList.mockResolvedValue([] as Project[])
    mockProfilesList.mockResolvedValue([profile({ id: 'chief-1', name: 'Chief', tier: 'chief', charter: 'chief' })])
    mockRun.mockResolvedValue({ pipelineRunId: 'run-1' })

    renderPane()
    await screen.findByTestId('pipeline-def-def-1')
    fireEvent.click(screen.getByTestId('pipeline-run-open'))
    await screen.findByTestId('pipeline-run-orchestrator')
    fireEvent.change(screen.getByTestId('pipeline-run-goal'), { target: { value: 'go' } })
    fireEvent.change(screen.getByTestId('pipeline-run-orchestrator'), { target: { value: 'chief-1' } })

    fireEvent.click(screen.getByTestId('pipeline-run-fire'))
    await waitFor(() => expect(mockRun).toHaveBeenCalled())
    const [, body] = mockRun.mock.calls[0]
    expect(body.orchestratorId).toBe('chief-1')
  })
})
