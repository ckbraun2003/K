/**
 * McpTab (wave C2) — trust-gated MCP servers (D-070). Locks: the enable toggle
 * is DISABLED while untrusted (with "Review & trust" offered instead), the
 * TrustDialog shows the full command before "Trust & enable" → trustMcp
 * ({enable:true}), a trust-gate 400 surfaces in-row, k-source servers are born
 * trusted / not toggleable / labeled, and est-token + tool-count are shown.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogMcpServer } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockMcp, mockToggle, mockTrust, mockProbe } = vi.hoisted(() => ({
  mockMcp: vi.fn(),
  mockToggle: vi.fn(),
  mockTrust: vi.fn(),
  mockProbe: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    capabilities: {
      mcp: mockMcp,
      toggleMcp: mockToggle,
      trustMcp: mockTrust,
      probeMcp: mockProbe,
    },
  },
}))

import McpTab from '../src/pages/skills/McpTab'

function server(over: Partial<CatalogMcpServer> & Pick<CatalogMcpServer, 'id'>): CatalogMcpServer {
  return {
    name: over.id,
    sourceKind: 'claude-user',
    pluginName: null,
    transport: 'stdio',
    commandSummary: 'npx -y @some/mcp-server --flag',
    trusted: false,
    enabled: false,
    estTokens: null,
    toolCount: null,
    mountedBy: [],
    status: 'ok',
    ...over,
  }
}

const servers: CatalogMcpServer[] = [
  server({ id: 'kstore', name: 'kstore', sourceKind: 'k', trusted: true, enabled: true, commandSummary: 'node kstore-server.mjs' }),
  server({ id: 'user:context7', name: 'context7', trusted: false, enabled: false }),
  server({ id: 'user:probed', name: 'probed', trusted: true, enabled: true, estTokens: 6200, toolCount: 14 }),
]

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <McpTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMcp.mockResolvedValue({ servers, scannedAt: 1, warnings: [] })
  mockToggle.mockResolvedValue(servers[2])
  mockTrust.mockResolvedValue({ ...servers[1], trusted: true, enabled: true })
  mockProbe.mockResolvedValue({ ...servers[2] })
})
afterEach(() => cleanup())

describe('McpTab — trust gating', () => {
  it('an untrusted server has a DISABLED toggle and offers Review & trust', async () => {
    renderTab()
    const toggle = await screen.findByTestId('mcp-toggle-user:context7')
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('mcp-untrusted-user:context7')).toBeTruthy()
    expect(screen.getByTestId('mcp-review-user:context7')).toBeTruthy()
  })

  it('Review & trust opens the dialog with the FULL command + source, and confirm calls trustMcp({enable:true})', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('mcp-review-user:context7'))
    const dialog = await screen.findByTestId('mcp-trust-dialog')
    expect(dialog.textContent).toContain('npx -y @some/mcp-server --flag')
    expect(dialog.textContent).toContain('claude-user')
    expect(dialog.textContent).toContain('stdio')
    fireEvent.click(screen.getByTestId('mcp-trust-dialog-confirm'))
    await waitFor(() => expect(mockTrust).toHaveBeenCalledWith('user:context7', { enable: true }))
  })

  it('a trust failure surfaces inside the dialog, not swallowed', async () => {
    mockTrust.mockRejectedValue(new Error('config drifted since scan — rescan first'))
    renderTab()
    fireEvent.click(await screen.findByTestId('mcp-review-user:context7'))
    fireEvent.click(screen.getByTestId('mcp-trust-dialog-confirm'))
    const err = await screen.findByTestId('mcp-trust-dialog-error')
    expect(err.textContent).toContain('config drifted since scan — rescan first')
  })

  it('a trusted server toggles through toggleMcp', async () => {
    renderTab()
    const toggle = await screen.findByTestId('mcp-toggle-user:probed')
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(mockToggle).toHaveBeenCalledWith('user:probed', false))
  })

  it('a toggle rejection (the trust-gate 400 shape) surfaces in-row', async () => {
    mockToggle.mockRejectedValue(new Error('cannot enable an untrusted server'))
    renderTab()
    fireEvent.click(await screen.findByTestId('mcp-toggle-user:probed'))
    const err = await screen.findByTestId('mcp-toggle-error-user:probed')
    expect(err.textContent).toContain('cannot enable an untrusted server')
  })
})

describe('McpTab — k-source servers', () => {
  it('are born trusted, labeled as K-managed, and not toggleable', async () => {
    renderTab()
    const toggle = await screen.findByTestId('mcp-toggle-kstore')
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('mcp-managed-kstore')).toBeTruthy()
    // no trust-review affordance for K's own servers
    expect(screen.queryByTestId('mcp-review-kstore')).toBeNull()
  })
})

describe('McpTab — row facts', () => {
  it('shows transport, mono command summary, and est tokens + tool count', async () => {
    renderTab()
    const row = await screen.findByTestId('mcp-row-user:probed')
    expect(row.textContent).toContain('stdio')
    expect(row.textContent).toContain('npx -y @some/mcp-server --flag')
    expect(row.textContent).toContain('~6.2k tok')
    expect(row.textContent).toContain('14 tools')
  })

  it('an unprobed server is honest about the unknown cost', async () => {
    renderTab()
    const row = await screen.findByTestId('mcp-row-user:context7')
    expect(row.textContent).toContain('tok n/a')
  })

  it('probe is offered on enabled+trusted servers and calls probeMcp', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('mcp-probe-user:probed'))
    await waitFor(() => expect(mockProbe).toHaveBeenCalledWith('user:probed'))
    // untrusted server: no probe affordance
    expect(screen.queryByTestId('mcp-probe-user:context7')).toBeNull()
  })
})
