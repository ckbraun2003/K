/**
 * CapabilityPicker (wave C3) — the catalog-backed mount editor for a profile's
 * skills / MCP servers. Locks: mounted-row rendering (badges + token chips),
 * add/remove emit the FULL next string[] (the parent PATCHes it), the add
 * combobox offers only catalog entries with disabled/untrusted ones grayed and
 * un-addable (+ catalog deep link), not-in-catalog mounts get a chip and stay
 * removable but never priced, and the footer subtotal prices the whole profile
 * via profileSubtotal. The grant-guard 400 banner stays PARENT-owned — locked
 * here through the OrchestratorDetailPage adoption.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogSkill, CatalogMcpServer, ChiefOrgLead } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockCatalogSkills, mockCatalogMcp, mockNavigate, mockOrchGet, mockOrchUpdate, mockLessons, mockRecentActuals } =
  vi.hoisted(() => ({
    mockCatalogSkills: vi.fn(),
    mockCatalogMcp: vi.fn(),
    mockNavigate: vi.fn(),
    mockOrchGet: vi.fn(),
    mockOrchUpdate: vi.fn(),
    mockLessons: vi.fn(),
    mockRecentActuals: vi.fn(),
  }))

vi.mock('../src/lib/api', () => ({
  api: {
    capabilities: { skills: mockCatalogSkills, mcp: mockCatalogMcp },
    orchestrators: { get: mockOrchGet, update: mockOrchUpdate },
    orgDefault: { get: vi.fn().mockResolvedValue({ skills: [], allowedTools: [], mcpServers: [] }) },
    memory: { lessons: mockLessons, approve: vi.fn(), reject: vi.fn() },
    metrics: { recentActuals: mockRecentActuals },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import CapabilityPicker from '../src/components/CapabilityPicker'
import OrchestratorDetailPage from '../src/pages/OrchestratorDetailPage'

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id,
    description: null,
    sourceKind: 'k',
    pluginName: null,
    path: 'x/SKILL.md',
    enabled: true,
    estTokens: null,
    estTokensMeta: null,
    modelCompat: 'universal',
    mountedBy: [],
    status: 'ok',
    updatedAt: null,
    ...over,
  }
}

function server(over: Partial<CatalogMcpServer> & Pick<CatalogMcpServer, 'id'>): CatalogMcpServer {
  return {
    name: over.id,
    sourceKind: 'claude-user',
    pluginName: null,
    transport: 'stdio',
    commandSummary: 'npx server',
    trusted: true,
    enabled: true,
    estTokens: null,
    toolCount: null,
    mountedBy: [],
    status: 'ok',
    ...over,
  }
}

const catalogSkills: CatalogSkill[] = [
  skill({ id: 'deep-research', estTokens: 1200 }),
  skill({
    id: 'plugin:superpowers@obra:brainstorming',
    name: 'brainstorming',
    sourceKind: 'claude-plugin',
    pluginName: 'superpowers',
    estTokens: 800,
  }),
  skill({ id: 'user:web-audit', name: 'web-audit', sourceKind: 'claude-user', enabled: false }),
]
const catalogServers: CatalogMcpServer[] = [
  server({ id: 'user:context7', name: 'context7', estTokens: 3000 }),
  server({ id: 'user:sketchy', name: 'sketchy', trusted: false, enabled: false }),
]

function renderPicker(opts: {
  kind: 'skills' | 'mcp'
  profile: { skills: string[]; mcpServers: string[] }
  onChange?: (next: string[]) => void
  busy?: boolean
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = opts.onChange ?? vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <CapabilityPicker
        kind={opts.kind}
        profile={opts.profile}
        onChange={onChange}
        busy={opts.busy ?? false}
        testidPrefix="pick"
      />
    </QueryClientProvider>,
  )
  return onChange
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCatalogSkills.mockResolvedValue({ skills: catalogSkills, scannedAt: 1, warnings: [] })
  mockCatalogMcp.mockResolvedValue({ servers: catalogServers, scannedAt: 1, warnings: [] })
  mockLessons.mockResolvedValue([])
  mockRecentActuals.mockResolvedValue({ scope: 'none', n: 0, windowDays: 30, medianCostUsd: null, p90CostUsd: null })
})
afterEach(() => cleanup())

describe('CapabilityPicker — mounted rows', () => {
  it('renders catalog-resolved mounts with badge + token chip and removes by emitting the next array', async () => {
    const onChange = renderPicker({
      kind: 'skills',
      profile: { skills: ['deep-research', 'plugin:superpowers@obra:brainstorming'], mcpServers: [] },
    })
    // the subtotal renders only once BOTH catalog reads land — mounted rows
    // resolve from ghosts to catalog hits at that same point
    await screen.findByTestId('pick-subtotal')
    const remove = screen.getByTestId('pick-remove-deep-research')
    const panel = screen.getByTestId('pick-panel')
    expect(panel.textContent).toContain('deep-research')
    expect(panel.textContent).toContain('~1.2k tok')
    expect(panel.textContent).toContain('superpowers') // plugin badge names the plugin
    fireEvent.click(remove)
    expect(onChange).toHaveBeenCalledWith(['plugin:superpowers@obra:brainstorming'])
  })

  it('a not-in-catalog mount gets a chip, stays removable, and is excluded from the subtotal', async () => {
    const onChange = renderPicker({
      kind: 'skills',
      profile: { skills: ['deep-research', 'ghost-skill'], mcpServers: [] },
    })
    const subtotal = await screen.findByTestId('pick-subtotal')
    expect(screen.getByTestId('pick-ghost-ghost-skill')).toBeTruthy()
    expect(subtotal.textContent).toContain('~1.2k tok') // ghost NOT priced in
    expect(subtotal.textContent).toContain('1 not in catalog (excluded)')
    fireEvent.click(screen.getByTestId('pick-remove-ghost-skill'))
    expect(onChange).toHaveBeenCalledWith(['deep-research'])
  })

  it('a mounted entry that is no longer mountable is flagged stale, not shown healthy', async () => {
    renderPicker({ kind: 'skills', profile: { skills: ['user:web-audit'], mcpServers: [] } })
    const stale = await screen.findByTestId('pick-stale-user:web-audit')
    expect(stale.getAttribute('title')).toContain('enable it in the catalog first')
  })
})

describe('CapabilityPicker — add combobox', () => {
  it('offers unmounted catalog entries; clicking an addable one emits the appended array', async () => {
    const onChange = renderPicker({
      kind: 'skills',
      profile: { skills: ['deep-research'], mcpServers: [] },
    })
    await screen.findByTestId('pick-subtotal')
    fireEvent.focus(screen.getByTestId('pick-input'))
    // mounted entries are NOT offered again
    expect(screen.queryByTestId('pick-option-deep-research')).toBeNull()
    fireEvent.click(screen.getByTestId('pick-option-plugin:superpowers@obra:brainstorming'))
    expect(onChange).toHaveBeenCalledWith(['deep-research', 'plugin:superpowers@obra:brainstorming'])
  })

  it('typing filters the candidates', async () => {
    renderPicker({ kind: 'skills', profile: { skills: [], mcpServers: [] } })
    await screen.findByTestId('pick-subtotal')
    fireEvent.change(screen.getByTestId('pick-input'), { target: { value: 'brainstorm' } })
    expect(screen.getByTestId('pick-option-plugin:superpowers@obra:brainstorming')).toBeTruthy()
    expect(screen.queryByTestId('pick-option-deep-research')).toBeNull()
  })

  it('is keyboard-operable: arrows rove the cursor, Enter adds, Escape closes', async () => {
    const onChange = renderPicker({ kind: 'skills', profile: { skills: [], mcpServers: [] } })
    await screen.findByTestId('pick-subtotal')
    const input = screen.getByTestId('pick-input')
    fireEvent.focus(input)
    // candidates sort addable-first then by name: brainstorming, deep-research, web-audit
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(
      'pick-option-plugin:superpowers@obra:brainstorming',
    )
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('pick-option-deep-research')
    expect(screen.getByTestId('pick-option-deep-research').getAttribute('aria-selected')).toBe('true')
    fireEvent.submit(input.closest('form')!)
    expect(onChange).toHaveBeenCalledWith(['deep-research'])
    // Escape collapses the listbox
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('pick-options')).toBeNull()
    // options are not tab stops — the input owns focus (ARIA combobox pattern)
    fireEvent.focus(input)
    expect(screen.getByTestId('pick-option-user:web-audit').getAttribute('tabindex')).toBe('-1')
  })

  it('a disabled skill is grayed, un-addable, and links to the catalog', async () => {
    const onChange = renderPicker({ kind: 'skills', profile: { skills: [], mcpServers: [] } })
    await screen.findByTestId('pick-subtotal')
    fireEvent.focus(screen.getByTestId('pick-input'))
    const opt = screen.getByTestId('pick-option-user:web-audit')
    expect(opt.getAttribute('aria-disabled')).toBe('true')
    expect(opt.textContent).toContain('enable it in the catalog first')
    fireEvent.click(opt)
    expect(onChange).not.toHaveBeenCalled()
    // deep link goes to the skills catalog tab
    fireEvent.click(screen.getByTestId('pick-catalog-link'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'skills', undefined)
  })

  it('an untrusted MCP server is grayed and the deep link targets #/skills/mcp', async () => {
    const onChange = renderPicker({ kind: 'mcp', profile: { skills: [], mcpServers: [] } })
    await screen.findByTestId('pick-subtotal')
    fireEvent.focus(screen.getByTestId('pick-input'))
    const opt = screen.getByTestId('pick-option-user:sketchy')
    expect(opt.getAttribute('aria-disabled')).toBe('true')
    expect(opt.textContent).toContain('untrusted — enable it in the catalog first')
    fireEvent.click(opt)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('pick-catalog-link'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'skills', 'mcp')
  })

  it('Enter adds only an exact ADDABLE match (keyboard cannot bypass the gray-out)', async () => {
    const onChange = renderPicker({ kind: 'skills', profile: { skills: [], mcpServers: [] } })
    await screen.findByTestId('pick-subtotal')
    const input = screen.getByTestId('pick-input')
    fireEvent.change(input, { target: { value: 'web-audit' } })
    fireEvent.submit(input.closest('form')!)
    expect(onChange).not.toHaveBeenCalled() // disabled entry — prevented
    fireEvent.change(input, { target: { value: 'deep-research' } })
    fireEvent.submit(input.closest('form')!)
    expect(onChange).toHaveBeenCalledWith(['deep-research'])
  })
})

describe('CapabilityPicker — footer subtotal', () => {
  it('prices the WHOLE profile (skills + MCP) with the unestimated footnote', async () => {
    renderPicker({
      kind: 'skills',
      profile: {
        skills: ['deep-research', 'plugin:superpowers@obra:brainstorming'],
        mcpServers: ['user:context7', 'user:sketchy'],
      },
    })
    const subtotal = await screen.findByTestId('pick-subtotal')
    // 1200 + 800 skills, 3000 mcp, sketchy unestimated (null)
    expect(subtotal.textContent).toContain('~5.0k tok')
    expect(subtotal.textContent).toContain('skills ~2.0k')
    expect(subtotal.textContent).toContain('MCP ~3.0k')
    expect(subtotal.textContent).toContain('1 not yet measured')
  })
})

describe('OrchestratorDetailPage adoption — grant-guard banner stays parent-owned', () => {
  const lead: ChiefOrgLead = {
    profile: {
      id: 'lead-web',
      name: 'Web Lead',
      tier: 'orchestrator',
      charter: 'orchestrator',
      skills: ['deep-research'],
      allowedTools: [],
      mcpServers: [],
      defaultModel: null,
    } as unknown as ChiefOrgLead['profile'],
    assignments: [],
    activeRuns: [],
    recent: null,
    effectiveModel: null,
  } as unknown as ChiefOrgLead

  it('surfaces the 400 grant-guard message verbatim in the existing banner after a picker add', async () => {
    mockOrchGet.mockResolvedValue(lead)
    mockOrchUpdate.mockRejectedValue(
      new Error('mcp server "user:context7" requires a matching allowlist grant'),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <OrchestratorDetailPage id="lead-web" />
      </QueryClientProvider>,
    )
    // open the MCP tab, add an addable server through the picker
    fireEvent.click(await screen.findByTestId('seg-mcp'))
    fireEvent.focus(await screen.findByTestId('orchestrator-mcp-input'))
    fireEvent.click(await screen.findByTestId('orchestrator-mcp-option-user:context7'))
    await waitFor(() => expect(mockOrchUpdate).toHaveBeenCalledWith('lead-web', { mcpServers: ['user:context7'] }))
    const banner = await screen.findByTestId('orchestrator-error')
    expect(banner.textContent).toBe('mcp server "user:context7" requires a matching allowlist grant')
  })
})
