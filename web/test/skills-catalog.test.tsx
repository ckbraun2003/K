/**
 * CatalogTab (wave C2) — the unified capability catalog. Locks: provenance +
 * compat + token rendering per row, the K-scoped enable dot wiring, facet
 * filters (source / enabled-only / search), the rescan action, the amber
 * warnings banner, the empty-with-warnings state, missing-status honesty and
 * mountedBy deep links.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogSkill } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockSkills, mockToggle, mockRescan, mockNavigate } = vi.hoisted(() => ({
  mockSkills: vi.fn(),
  mockToggle: vi.fn(),
  mockRescan: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    capabilities: {
      skills: mockSkills,
      toggleSkill: mockToggle,
      rescan: mockRescan,
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import CatalogTab from '../src/pages/skills/CatalogTab'

function skill(over: Partial<CatalogSkill> & Pick<CatalogSkill, 'id'>): CatalogSkill {
  return {
    name: over.id,
    description: null,
    sourceKind: 'k',
    pluginName: null,
    path: `agent-config/skills/${over.id}/SKILL.md`,
    enabled: false,
    estTokens: null,
    estTokensMeta: null,
    modelCompat: 'universal',
    mountedBy: [],
    status: 'ok',
    updatedAt: null,
    ...over,
  }
}

const catalog: CatalogSkill[] = [
  skill({
    id: 'deep-research',
    name: 'deep-research',
    description: 'fan-out research harness',
    enabled: true,
    estTokens: 4200,
    estTokensMeta: 60,
    mountedBy: ['lead-web'],
  }),
  skill({
    id: 'plugin:superpowers@obra:brainstorming',
    name: 'brainstorming',
    sourceKind: 'claude-plugin',
    pluginName: 'superpowers',
    modelCompat: 'claude-only',
    path: 'C:/Users/x/.claude/plugins/cache/superpowers/skills/brainstorming/SKILL.md',
  }),
  skill({ id: 'user:gone-skill', name: 'gone-skill', sourceKind: 'claude-user', status: 'missing', enabled: true }),
]

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CatalogTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSkills.mockResolvedValue({ skills: catalog, scannedAt: 1700000000000, warnings: [] })
  mockToggle.mockResolvedValue(catalog[0])
  mockRescan.mockResolvedValue({ scannedAt: 1, skills: { discovered: 0, updated: 0, missing: 0 }, mcpServers: { discovered: 0, updated: 0, missing: 0 }, warnings: [] })
})
afterEach(() => cleanup())

describe('CatalogTab — rows', () => {
  it('renders name, provenance badge, compat badge and relative weight band', async () => {
    renderTab()
    const row = await screen.findByTestId('catalog-row-deep-research')
    expect(row.textContent).toContain('deep-research')
    expect(row.textContent).toContain('K') // source badge
    expect(row.textContent).toContain('universal')
    // deep-research is the only measured skill, so it is the catalog's refMax -> heavy band.
    expect(row.textContent).toContain('heavy weight')
    expect(row.textContent).toContain('fan-out research harness')
  })

  it('the plugin badge names the plugin, not just "plugin"', async () => {
    renderTab()
    const row = await screen.findByTestId('catalog-row-plugin:superpowers@obra:brainstorming')
    expect(row.textContent).toContain('superpowers')
  })

  it('a null estTokens renders an honest "weight n/a" band', async () => {
    renderTab()
    const row = await screen.findByTestId('catalog-row-plugin:superpowers@obra:brainstorming')
    expect(row.textContent).toContain('weight n/a')
  })

  it('status=missing is rendered clearly and blocks enabling', async () => {
    renderTab()
    await screen.findByTestId('catalog-missing-user:gone-skill')
    const dot = screen.getByTestId('catalog-toggle-user:gone-skill')
    // enabled+missing can still be DISABLED (fail-open for turning off) — but a
    // disabled missing row could not be re-enabled. This row is enabled, so the
    // switch stays operable for the off direction.
    expect(dot.getAttribute('aria-checked')).toBe('true')
  })

  it('the enable dot is a switch wired to toggleSkill with the flipped value', async () => {
    renderTab()
    const dot = await screen.findByTestId('catalog-toggle-deep-research')
    expect(dot.getAttribute('role')).toBe('switch')
    expect(dot.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(dot)
    await waitFor(() => expect(mockToggle).toHaveBeenCalledWith('deep-research', false))
  })

  it('a toggle failure surfaces the server message in-row', async () => {
    mockToggle.mockRejectedValue(new Error('skill is missing on disk — rescan first'))
    renderTab()
    fireEvent.click(await screen.findByTestId('catalog-toggle-deep-research'))
    const err = await screen.findByTestId('catalog-toggle-error-deep-research')
    expect(err.textContent).toContain('skill is missing on disk — rescan first')
  })

  it('mountedBy chips deep-link to the orchestrator detail', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('catalog-mountedby-deep-research-lead-web'))
    expect(mockNavigate).toHaveBeenCalledWith('orchestrator', 'lead-web')
  })

  it('the details preview exposes the SKILL.md path read-only', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('catalog-preview-toggle-deep-research'))
    const preview = screen.getByTestId('catalog-preview-deep-research')
    expect(preview.textContent).toContain('agent-config/skills/deep-research/SKILL.md')
    expect(preview.textContent).toContain('Read-only')
  })
})

describe('CatalogTab — filters', () => {
  it('text search narrows the list', async () => {
    renderTab()
    await screen.findByTestId('catalog-row-deep-research')
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'brainstorm' } })
    expect(screen.queryByTestId('catalog-row-deep-research')).toBeNull()
    expect(screen.getByTestId('catalog-row-plugin:superpowers@obra:brainstorming')).toBeTruthy()
  })

  it('the source facet narrows by provenance', async () => {
    renderTab()
    await screen.findByTestId('catalog-row-deep-research')
    fireEvent.click(screen.getByRole('button', { name: 'Plugin' }))
    expect(screen.queryByTestId('catalog-row-deep-research')).toBeNull()
    expect(screen.getByTestId('catalog-row-plugin:superpowers@obra:brainstorming')).toBeTruthy()
  })

  it('enabled-only hides overlay-disabled entries', async () => {
    renderTab()
    await screen.findByTestId('catalog-row-deep-research')
    fireEvent.click(screen.getByTestId('catalog-enabled-only'))
    expect(screen.queryByTestId('catalog-row-plugin:superpowers@obra:brainstorming')).toBeNull()
    expect(screen.getByTestId('catalog-row-deep-research')).toBeTruthy()
  })

  it('filtered-to-empty says so instead of rendering a void', async () => {
    renderTab()
    await screen.findByTestId('catalog-row-deep-research')
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('No entries match the current filters.')).toBeTruthy()
  })
})

describe('CatalogTab — rescan + warnings', () => {
  it('the rescan button POSTs a rescan', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('catalog-rescan'))
    await waitFor(() => expect(mockRescan).toHaveBeenCalledTimes(1))
  })

  it('non-empty warnings render the amber banner with path + message', async () => {
    mockSkills.mockResolvedValue({
      skills: catalog,
      scannedAt: 1,
      warnings: [{ path: 'C:/Users/x/.claude/skills/broken', message: 'malformed SKILL.md frontmatter' }],
    })
    renderTab()
    const banner = await screen.findByTestId('catalog-warnings')
    expect(banner.textContent).toContain('C:/Users/x/.claude/skills/broken')
    expect(banner.textContent).toContain('malformed SKILL.md frontmatter')
  })

  it('empty catalog WITH warnings explains that discovery found nothing readable', async () => {
    mockSkills.mockResolvedValue({
      skills: [],
      scannedAt: 1,
      warnings: [{ path: '~/.claude/skills', message: 'EACCES' }],
    })
    renderTab()
    const empty = await screen.findByTestId('catalog-empty')
    expect(empty.textContent).toBe('Host discovery found nothing readable.')
  })

  it('empty catalog WITHOUT warnings nudges toward a rescan instead', async () => {
    mockSkills.mockResolvedValue({ skills: [], scannedAt: null, warnings: [] })
    renderTab()
    const empty = await screen.findByTestId('catalog-empty')
    expect(empty.textContent).toContain('rescan to discover host skills')
  })
})
