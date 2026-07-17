/**
 * C.6 (usability-access Phase 2.6) — AccessPage: the unified "who can run what"
 * console. One matrix, every dispatchable agent (orchestrator leads AND
 * sub-agent workers, both K-native and operator) as a row; Model/Tools/Skills/
 * MCP counts as columns; an expandable inline editor per row reuses C.4's
 * model Select + C.5's CapabilityPicker (skills/mcp) + the free-text Tools
 * chip field. K-native workers expand to a read-only summary, no Save. A
 * prominent header "Auto-index" button re-scans the capability catalog.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OrchestratorRosterPayload, SubAgentDef, AvailableModelsResponse } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion / radix media queries
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const {
  mockOrchList, mockOrchUpdate, mockSubList, mockSubUpdate,
  mockCatalogSkills, mockCatalogMcp, mockModelsAvailable, mockRescan,
} = vi.hoisted(() => ({
  mockOrchList: vi.fn(),
  mockOrchUpdate: vi.fn(),
  mockSubList: vi.fn(),
  mockSubUpdate: vi.fn(),
  mockCatalogSkills: vi.fn(),
  mockCatalogMcp: vi.fn(),
  mockModelsAvailable: vi.fn(),
  mockRescan: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    orchestrators: { list: mockOrchList, update: mockOrchUpdate },
    subAgents: { list: mockSubList, update: mockSubUpdate },
    capabilities: { skills: mockCatalogSkills, mcp: mockCatalogMcp, rescan: mockRescan },
    models: { available: mockModelsAvailable },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import AccessPage from '../src/pages/AccessPage'

const ROSTER: OrchestratorRosterPayload = {
  leads: [
    {
      profile: {
        id: 'lead-web', name: 'Web Lead', tier: 'orchestrator', charter: 'orchestrator',
        defaultModel: null, allowedTools: ['Read'], mcpServers: [], skills: ['deep-research'],
      },
      latestRun: null, live: false, wakes: 0,
    },
  ],
  activeLeads: 0,
}

const K_WORKER: SubAgentDef = {
  id: 'k:builder', name: 'builder', role: 'builds stuff', model: 'sonnet',
  allowedTools: ['Read', 'Write'], mcpServers: [], skills: ['ts-review'],
  prompt: 'You build things.', source: 'k', enabled: true,
}
const OP_WORKER: SubAgentDef = {
  id: 'op-1', name: 'custom-worker', role: 'custom role', model: null,
  allowedTools: [], mcpServers: ['github'], skills: [],
  prompt: 'Do custom work.', source: 'operator', enabled: true,
}

const MODELS: AvailableModelsResponse = {
  models: [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', kind: 'claude', contextWindow: 200_000 },
    { id: 'llama3.2:3b', label: 'llama3.2:3b', kind: 'local' },
  ],
  localDegraded: false,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AccessPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockOrchList.mockReset(); mockOrchUpdate.mockReset()
  mockSubList.mockReset(); mockSubUpdate.mockReset()
  mockCatalogSkills.mockReset(); mockCatalogMcp.mockReset()
  mockModelsAvailable.mockReset(); mockRescan.mockReset()

  mockOrchList.mockResolvedValue(ROSTER)
  mockSubList.mockResolvedValue([K_WORKER, OP_WORKER])
  mockCatalogSkills.mockResolvedValue({ skills: [], scannedAt: null, warnings: [] })
  mockCatalogMcp.mockResolvedValue({ servers: [], scannedAt: null, warnings: [] })
  mockModelsAvailable.mockResolvedValue(MODELS)
  mockRescan.mockResolvedValue({ scannedAt: Date.now(), skillCount: 0, mcpCount: 0, warnings: [] })
  mockOrchUpdate.mockResolvedValue({})
  mockSubUpdate.mockResolvedValue(OP_WORKER)
})
afterEach(() => cleanup())

describe('AccessPage — matrix render', () => {
  it('renders one row per orchestrator lead AND per sub-agent worker (K-native + operator)', async () => {
    renderPage()
    await screen.findByTestId('access-row-lead-web')
    expect(screen.getByTestId('access-row-k:builder')).toBeTruthy()
    expect(screen.getByTestId('access-row-op-1')).toBeTruthy()
  })

  it('shows Tools/Skills/MCP counts per row', async () => {
    renderPage()
    const row = await screen.findByTestId('access-row-k:builder')
    // K_WORKER: 2 tools, 1 skill, 0 mcp
    const cells = row.querySelectorAll('td')
    const texts = Array.from(cells).map(c => c.textContent?.trim())
    expect(texts).toContain('2')
    expect(texts).toContain('1')
    expect(texts).toContain('0')
  })
})

describe('AccessPage — Auto-index button', () => {
  it('calls api.capabilities.rescan() when clicked', async () => {
    renderPage()
    await screen.findByTestId('access-row-lead-web')
    fireEvent.click(screen.getByTestId('access-rescan'))
    await waitFor(() => expect(mockRescan).toHaveBeenCalledTimes(1))
  })
})

describe('AccessPage — K-native worker rows are read-only', () => {
  it('expanding a K-native row shows no Save control', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('access-expand-k:builder'))
    await screen.findByTestId('access-row-expanded-k:builder')
    expect(screen.queryByTestId('access-save-k:builder')).toBeNull()
  })
})

describe('AccessPage — expandable inline editor for an operator worker row', () => {
  it('expanding shows the model Select + Skills/MCP pickers + Tools chip field, pre-filled', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('access-expand-op-1'))
    await screen.findByTestId('access-row-expanded-op-1')

    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())
    expect(screen.getByTestId('access-model-op-1')).toBeTruthy()
    expect(screen.getByTestId('access-skills-op-1-panel')).toBeTruthy()
    expect(screen.getByTestId('access-mcp-op-1-panel')).toBeTruthy()
    expect(screen.getByTestId('access-tools-op-1-input')).toBeTruthy()
  })

  it('Save calls api.subAgents.update with the current (unedited) grant arrays + model', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('access-expand-op-1'))
    await screen.findByTestId('access-row-expanded-op-1')
    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('access-save-op-1'))
    await waitFor(() => expect(mockSubUpdate).toHaveBeenCalledWith('op-1', {
      model: null, allowedTools: [], mcpServers: ['github'], skills: [],
    }))
  })
})

describe('AccessPage — expandable inline editor for an orchestrator lead row', () => {
  it('Save calls api.orchestrators.update with defaultModel + grant arrays', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('access-expand-lead-web'))
    await screen.findByTestId('access-row-expanded-lead-web')
    await waitFor(() => expect(mockModelsAvailable).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('access-save-lead-web'))
    await waitFor(() => expect(mockOrchUpdate).toHaveBeenCalledWith('lead-web', {
      defaultModel: null, allowedTools: ['Read'], mcpServers: [], skills: ['deep-research'],
    }))
  })
})
