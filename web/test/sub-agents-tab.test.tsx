/**
 * SubAgentsTab (Task B.5 — orch-p2 Lane B) — the Catalog "Sub Agents" sub-tab: the
 * dispatchable worker-bee registry. Locks:
 *   - list render: cards surface name/role/model/chips/source badge for BOTH
 *     K-native (source:'k') and operator (source:'operator') rows
 *   - fork flow: "Fork to edit" on a K-native card opens the editor pre-filled from
 *     the source (name suggested as `${name}-copy`), and Save calls
 *     api.subAgents.create with cloneFrom set to the K-native id
 *   - save calls PATCH: editing an operator card and saving calls api.subAgents.update
 *   - K-native has no delete affordance at all (not just disabled)
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SubAgentDef } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion / radix media queries
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockList, mockCreate, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    subAgents: { list: mockList, create: mockCreate, update: mockUpdate, delete: mockDelete },
  },
}))

import SubAgentsTab from '../src/pages/catalog/SubAgentsTab'

const K_AGENT: SubAgentDef = {
  id: 'k:builder', name: 'builder', role: 'builds stuff end to end', model: 'sonnet',
  allowedTools: ['Read', 'Write'], mcpServers: [], skills: ['ts-review'],
  prompt: 'You build things.', source: 'k', enabled: true,
}
const OP_AGENT: SubAgentDef = {
  id: 'op-1', name: 'custom-worker', role: 'a custom operator role', model: null,
  allowedTools: [], mcpServers: ['github'], skills: [],
  prompt: 'Do custom work.', source: 'operator', enabled: true,
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SubAgentsTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([K_AGENT, OP_AGENT])
  mockCreate.mockResolvedValue({ ...K_AGENT, id: 'op-2', source: 'operator', name: 'builder-copy' })
  mockUpdate.mockResolvedValue(OP_AGENT)
})
afterEach(() => cleanup())

describe('SubAgentsTab — list render', () => {
  it('renders a card per sub-agent with name/role/model/chips/source badge', async () => {
    renderTab()
    const kCard = await screen.findByTestId(`sub-agent-card-${K_AGENT.id}`)
    expect(kCard.textContent).toContain('builder')
    expect(kCard.textContent).toContain('builds stuff end to end')
    expect(kCard.textContent).toContain('sonnet')
    expect(kCard.textContent).toContain('Read')
    expect(kCard.textContent).toContain('ts-review')
    expect(kCard.querySelector('[title="source: k"]')).toBeTruthy()

    const opCard = screen.getByTestId(`sub-agent-card-${OP_AGENT.id}`)
    expect(opCard.textContent).toContain('custom-worker')
    expect(opCard.textContent).toContain('a custom operator role')
    expect(opCard.textContent).toContain('github')
    expect(opCard.querySelector('[title="source: operator"]')).toBeTruthy()
  })

  it('shows the empty state when there are no sub-agents', async () => {
    mockList.mockResolvedValue([])
    renderTab()
    await screen.findByTestId('sub-agents-empty')
  })
})

describe('SubAgentsTab — fork flow (K-native → operator copy)', () => {
  it('opens the editor pre-filled from the source, and Save calls create() with cloneFrom', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId(`sub-agent-fork-${K_AGENT.id}`))

    const nameInput = await screen.findByTestId('sub-agent-editor-name') as HTMLInputElement
    expect(nameInput.value).toBe('builder-copy')
    const roleInput = screen.getByTestId('sub-agent-editor-role') as HTMLInputElement
    expect(roleInput.value).toBe(K_AGENT.role)

    fireEvent.click(screen.getByTestId('sub-agent-editor-save'))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'builder-copy',
      role: K_AGENT.role,
      prompt: K_AGENT.prompt,
      cloneFrom: K_AGENT.id,
    }))
  })
})

describe('SubAgentsTab — operator edit calls update() (PATCH)', () => {
  it('editing an operator card and saving calls api.subAgents.update', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId(`sub-agent-edit-${OP_AGENT.id}`))

    const roleInput = await screen.findByTestId('sub-agent-editor-role') as HTMLInputElement
    expect(roleInput.value).toBe(OP_AGENT.role)
    fireEvent.change(roleInput, { target: { value: 'an updated operator role' } })

    fireEvent.click(screen.getByTestId('sub-agent-editor-save'))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(
      OP_AGENT.id,
      expect.objectContaining({ role: 'an updated operator role' }),
    )
  })
})

describe('SubAgentsTab — K-native rows have no delete affordance', () => {
  it('renders Fork but no Edit/Delete button for a K-native card', async () => {
    renderTab()
    await screen.findByTestId(`sub-agent-card-${K_AGENT.id}`)
    expect(screen.queryByTestId(`sub-agent-delete-${K_AGENT.id}`)).toBeNull()
    expect(screen.queryByTestId(`sub-agent-edit-${K_AGENT.id}`)).toBeNull()
    expect(screen.getByTestId(`sub-agent-fork-${K_AGENT.id}`)).toBeTruthy()
  })

  it('operator cards DO have a delete button', async () => {
    renderTab()
    expect(await screen.findByTestId(`sub-agent-delete-${OP_AGENT.id}`)).toBeTruthy()
  })
})
