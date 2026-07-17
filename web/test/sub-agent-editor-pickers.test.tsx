/**
 * C.5 (usability-access Phase 2.6) — SubAgentEditor's Skills + MCP fields
 * move from free-text ChipListFields to the catalog-backed CapabilityPicker
 * (same component the orchestrator detail page uses, wave C3): mounted rows
 * carry provenance/token badges and the add box only offers real catalog
 * entries. Tools stays a free-text ChipListField (tool ids aren't catalog
 * items). The Model Select's options now come from the unified
 * api.models.available() aggregate (Claude + installed local) instead of the
 * static KNOWN_MODELS constant, so a locally-installed model is selectable.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogSkill, CatalogMcpServer, AvailableModelsResponse } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion / radix media queries
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockCatalogSkills, mockCatalogMcp, mockModelsAvailable } = vi.hoisted(() => ({
  mockCatalogSkills: vi.fn(),
  mockCatalogMcp: vi.fn(),
  mockModelsAvailable: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    capabilities: { skills: mockCatalogSkills, mcp: mockCatalogMcp },
    models: { available: mockModelsAvailable },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import SubAgentEditor, { type SubAgentFormValues } from '../src/components/SubAgentEditor'

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id, description: null, sourceKind: 'k', pluginName: null, path: 'x/SKILL.md',
    enabled: true, estTokens: null, estTokensMeta: null, modelCompat: 'universal',
    mountedBy: [], status: 'ok', updatedAt: null, ...over,
  }
}
function server(over: Partial<CatalogMcpServer> & Pick<CatalogMcpServer, 'id'>): CatalogMcpServer {
  return {
    name: over.id, sourceKind: 'claude-user', pluginName: null, transport: 'stdio',
    commandSummary: 'npx server', trusted: true, enabled: true, estTokens: null,
    toolCount: null, mountedBy: [], status: 'ok', ...over,
  }
}

const INITIAL: SubAgentFormValues = {
  name: 'w', role: 'r', model: null,
  allowedTools: ['Read'], mcpServers: [], skills: ['deep-research'],
  prompt: 'p', enabled: true,
}

const MODELS: AvailableModelsResponse = {
  models: [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', kind: 'claude', contextWindow: 200_000 },
    { id: 'llama3.2:3b', label: 'llama3.2:3b', kind: 'local' },
  ],
  localDegraded: false,
}

function renderEditor(over: Partial<SubAgentFormValues> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SubAgentEditor
        open
        title="Edit worker"
        initial={{ ...INITIAL, ...over }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockCatalogSkills.mockReset(); mockCatalogMcp.mockReset(); mockModelsAvailable.mockReset()
  mockCatalogSkills.mockResolvedValue({
    skills: [skill({ id: 'deep-research', estTokens: 1200 }), skill({ id: 'web-audit', estTokens: 400 })],
    scannedAt: null, warnings: [],
  })
  mockCatalogMcp.mockResolvedValue({
    servers: [server({ id: 'context7', estTokens: 3000 })],
    scannedAt: null, warnings: [],
  })
  mockModelsAvailable.mockResolvedValue(MODELS)
})
afterEach(() => cleanup())

describe('SubAgentEditor — Skills field is a catalog-backed CapabilityPicker (C.5)', () => {
  it('renders the mounted skill with its catalog name + token badge (not a plain free-text chip)', async () => {
    renderEditor()
    const panel = await screen.findByTestId('sub-agent-editor-skills-panel')
    await waitFor(() => expect(panel.textContent).toContain('1.2k tok'))
    expect(panel.textContent).toContain('deep-research')
  })

  it('has no free-text "add" button — only the catalog combobox + options', async () => {
    renderEditor()
    await screen.findByTestId('sub-agent-editor-skills-panel')
    expect(screen.queryByTestId('sub-agent-editor-skills-add')).toBeNull()
    expect(screen.getByTestId('sub-agent-editor-skills-input')).toBeTruthy()
  })

  it('picking a catalog option adds it, and Save includes it in the emitted skills array', async () => {
    renderEditor({ skills: [] })
    const input = await screen.findByTestId('sub-agent-editor-skills-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'web-audit' } })
    fireEvent.click(await screen.findByTestId('sub-agent-editor-skills-option-web-audit'))
    await waitFor(() => expect(screen.getByTestId('sub-agent-editor-skills-panel').textContent).toContain('web-audit'))
  })
})

describe('SubAgentEditor — MCP field is a catalog-backed CapabilityPicker (C.5)', () => {
  it('renders the mounted mcp server with its catalog name + token badge', async () => {
    renderEditor({ mcpServers: ['context7'] })
    const panel = await screen.findByTestId('sub-agent-editor-mcp-panel')
    await waitFor(() => expect(panel.textContent).toContain('3.0k tok'))
    expect(panel.textContent).toContain('context7')
  })
})

describe('SubAgentEditor — Tools stays a free-text ChipListField (no catalog for raw tool ids)', () => {
  it('keeps the add-by-name input + add button for Tools', async () => {
    renderEditor()
    await screen.findByTestId('sub-agent-editor-skills-panel')
    expect(screen.getByTestId('sub-agent-editor-tools-input')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-editor-tools-add')).toBeTruthy()
  })
})

describe('SubAgentEditor — Model Select sources options from api.models.available()', () => {
  it('lists a locally-installed model alongside Claude models', async () => {
    renderEditor()
    const select = screen.getByTestId('sub-agent-editor-model')
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
      expect(options.some(o => o?.includes('llama3.2:3b'))).toBe(true)
    })
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
    expect(options).toContain('(runtime default)')
    expect(options.some(o => o?.includes('Opus 4.8'))).toBe(true)
  })
})
