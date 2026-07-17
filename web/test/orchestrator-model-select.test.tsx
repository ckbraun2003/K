/**
 * C.4 (usability-access Phase 2.6) — the orchestrator detail header gains an
 * EDITABLE default-model Select (was a read-only effectiveModel badge only).
 * Options come from the unified api.models.available() aggregate (Claude +
 * any installed local models); "(runtime default)" (value="") clears the
 * override back to null. Selecting a model PATCHes { defaultModel }.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChiefOrgLead, AgentProfile, RecentActuals, AvailableModelsResponse } from '@k/shared'

const { mockGet, mockUpdate, mockLessons, mockRecentActuals, mockModelsAvailable } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockLessons: vi.fn(),
  mockRecentActuals: vi.fn(),
  mockModelsAvailable: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    orchestrators: { get: mockGet, update: mockUpdate },
    memory: { lessons: mockLessons, approve: vi.fn(), reject: vi.fn() },
    orgDefault: { get: vi.fn() },
    metrics: { recentActuals: mockRecentActuals },
    models: { available: mockModelsAvailable },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import OrchestratorDetailPage from '../src/pages/OrchestratorDetailPage'

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'lead-web', name: 'Web Lead', tier: 'orchestrator', charter: 'orchestrator',
    defaultModel: null, allowedTools: [], mcpServers: [], skills: [], ...over,
  }
}
function detail(over: Partial<ChiefOrgLead> = {}): ChiefOrgLead {
  return {
    profile: profile(), latestRun: null, events: [], wakes: [],
    recent: null, effectiveModel: null, ...over,
  } as unknown as ChiefOrgLead
}

const NO_ACTUALS: RecentActuals = { scope: 'none', n: 0, windowDays: 30, medianCostUsd: null, p90CostUsd: null }
const MODELS: AvailableModelsResponse = {
  models: [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', kind: 'claude', contextWindow: 200_000 },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', kind: 'claude', contextWindow: 200_000 },
    { id: 'llama3.2:3b', label: 'llama3.2:3b', kind: 'local' },
  ],
  localDegraded: false,
}

function renderPage(id?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OrchestratorDetailPage id={id} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockGet.mockReset(); mockUpdate.mockReset(); mockLessons.mockReset()
  mockRecentActuals.mockReset(); mockModelsAvailable.mockReset()
  mockLessons.mockResolvedValue([])
  mockRecentActuals.mockResolvedValue(NO_ACTUALS)
  mockModelsAvailable.mockResolvedValue(MODELS)
  mockUpdate.mockResolvedValue({ ...profile(), defaultModel: 'claude-opus-4-8' })
})
afterEach(() => cleanup())

describe('OrchestratorDetailPage — editable default-model Select (C.4)', () => {
  it('lists the unified models plus a "(runtime default)" option', async () => {
    mockGet.mockResolvedValue(detail())
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })

    const select = await screen.findByTestId('orchestrator-model-select')
    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
    expect(options).toContain('(runtime default)')
    expect(options.some(o => o?.includes('Opus 4.8'))).toBe(true)
    expect(options.some(o => o?.includes('llama3.2:3b'))).toBe(true)
  })

  it('selecting a model PATCHes { defaultModel: <id> }', async () => {
    mockGet.mockResolvedValue(detail({ profile: profile({ defaultModel: null }) }))
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    const select = await screen.findByTestId('orchestrator-model-select')
    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())

    fireEvent.change(select, { target: { value: 'claude-opus-4-8' } })
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('lead-web', { defaultModel: 'claude-opus-4-8' }))
  })

  it('selecting "(runtime default)" PATCHes { defaultModel: null }', async () => {
    mockGet.mockResolvedValue(detail({ profile: profile({ defaultModel: 'claude-opus-4-8' }) }))
    renderPage('lead-web')
    await screen.findByRole('heading', { level: 1, name: 'Web Lead' })
    const select = await screen.findByTestId('orchestrator-model-select')
    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())

    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('lead-web', { defaultModel: null }))
  })
})
