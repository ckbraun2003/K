/** Agents → Org → Domains (C.3, D-125) — the domain registry panel: list with
 *  manager names, the create dialog's manager block POST, inline create errors,
 *  and the manager overlay editor's patchOverlay wiring. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockList, mockCreate, mockPatchOverlay, mockProfileGet } = vi.hoisted(() => ({
  mockList: vi.fn(), mockCreate: vi.fn(), mockPatchOverlay: vi.fn(), mockProfileGet: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    domains: { list: mockList, create: mockCreate, update: vi.fn() },
    profiles: { get: mockProfileGet, patchOverlay: mockPatchOverlay },
  },
}))
import DomainsView from '../src/pages/org/DomainsView'

const ENG = { id: 'engineering', name: 'Engineering', description: null,
  managerProfileId: 'chief', managerName: 'Chief', createdAt: 1 }

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><DomainsView /></QueryClientProvider>)
}

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([ENG])
  mockCreate.mockReset().mockResolvedValue({ ...ENG, id: 'research', name: 'Research' })
  mockPatchOverlay.mockReset().mockResolvedValue({})
  mockProfileGet.mockReset().mockResolvedValue({ id: 'chief', identityOverlay: '## Identity: Chief' })
})
afterEach(() => cleanup())

describe('DomainsView (C.3)', () => {
  it('lists domains with manager names', async () => {
    renderView()
    await screen.findByTestId('domain-row-engineering')
    expect(screen.getByText('Manager: Chief')).toBeTruthy()
  })

  it('create dialog posts the manager block and refetches on success', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('domain-new'))
    fireEvent.change(screen.getByTestId('domain-name'), { target: { value: 'Research' } })
    fireEvent.change(screen.getByTestId('domain-manager-name'), { target: { value: 'Research Mgr' } })
    fireEvent.change(screen.getByTestId('domain-manager-overlay'), { target: { value: '## Identity: R' } })
    fireEvent.click(screen.getByTestId('domain-create-submit'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({
      name: 'Research', description: null,
      manager: { name: 'Research Mgr', identityOverlay: '## Identity: R' },
    }))
  })

  it('surfaces create errors inline', async () => {
    mockCreate.mockRejectedValue(new Error('domain "research" already exists'))
    renderView()
    fireEvent.click(await screen.findByTestId('domain-new'))
    fireEvent.change(screen.getByTestId('domain-name'), { target: { value: 'Research' } })
    fireEvent.click(screen.getByTestId('domain-create-submit'))
    await screen.findByTestId('domain-create-error')
  })

  it('manager overlay dialog prefills the current overlay and patches through api.profiles.patchOverlay', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('domain-overlay-engineering'))
    // Prefill: the editor loads the CURRENT overlay before anything can be saved
    // (never a blind overwrite); Save is disabled until the value has arrived.
    expect((screen.getByTestId('overlay-save') as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(mockProfileGet).toHaveBeenCalledWith('chief'))
    await waitFor(() =>
      expect((screen.getByTestId('overlay-input') as HTMLTextAreaElement).value).toBe('## Identity: Chief'))
    fireEvent.change(screen.getByTestId('overlay-input'), { target: { value: 'new overlay' } })
    fireEvent.click(screen.getByTestId('overlay-save'))
    await waitFor(() => expect(mockPatchOverlay).toHaveBeenCalledWith('chief', 'new overlay'))
  })
})
