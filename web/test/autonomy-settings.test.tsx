/**
 * SettingsPage / AutonomousOrgSection (P5-B — the P5 on/off front door), and
 * OrgPage's read-only status chip. Mirrors settings-doctor.test.tsx's
 * mock-api + react-query-provider style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AutonomySettings } from '@k/shared'

const { mockGet, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn<[], Promise<AutonomySettings>>(),
  mockPatch: vi.fn(async (patch: Partial<AutonomySettings>) => ({ ...OFF, ...patch })),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    autonomy: { get: () => mockGet(), patch: (p: Partial<AutonomySettings>) => mockPatch(p) },
    // OrgPage's default 'roster' seg mounts RosterView, which fans out on this query —
    // stub it quiet so the status-chip tests aren't noisy about an unrelated page.
    orchestrators: { list: async () => ({ leads: [], activeLeads: 0 }) },
  },
}))

const mockNavigate = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import { AutonomousOrgSection } from '../src/pages/SettingsAutonomy'
import OrgPage from '../src/pages/OrgPage'

const OFF: AutonomySettings = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8,
}
const ON: AutonomySettings = {
  enabled: true, proposals: true, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 3, orgDailyBudgetUsd: 25, budgetWarnPct: 0.8,
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => { mockGet.mockReset(); mockPatch.mockClear(); mockNavigate.mockClear() })
afterEach(() => cleanup())

describe('AutonomousOrgSection — P5-B', () => {
  it('master switch OFF: sub-toggles + numeric fields render disabled', async () => {
    mockGet.mockResolvedValue(OFF)
    renderWithQuery(<AutonomousOrgSection />)
    const master = await screen.findByTestId('autonomy-enabled')
    expect((master as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('autonomy-proposals') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('autonomy-maxConcurrency') as HTMLInputElement).disabled).toBe(true)
  })

  it('clicking the master checkbox PATCHes { enabled: true }', async () => {
    mockGet.mockResolvedValue(OFF)
    renderWithQuery(<AutonomousOrgSection />)
    fireEvent.click(await screen.findByTestId('autonomy-enabled'))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ enabled: true }))
  })

  it('master ON: sub-toggles are enabled; clicking one PATCHes its own field', async () => {
    mockGet.mockResolvedValue(ON)
    renderWithQuery(<AutonomousOrgSection />)
    const proposals = await screen.findByTestId('autonomy-proposals')
    expect((proposals as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(proposals)
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ proposals: false }))
  })

  it('editing maxConcurrency and blurring commits a validated PATCH', async () => {
    mockGet.mockResolvedValue(ON)
    renderWithQuery(<AutonomousOrgSection />)
    const input = await screen.findByTestId('autonomy-maxConcurrency')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ maxConcurrency: 7 }))
  })

  it('an out-of-range maxConcurrency on blur reverts the draft instead of PATCHing', async () => {
    mockGet.mockResolvedValue(ON)
    renderWithQuery(<AutonomousOrgSection />)
    const input = await screen.findByTestId('autonomy-maxConcurrency') as HTMLInputElement
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    await waitFor(() => expect(input.value).toBe('3')) // reverted to ON.maxConcurrency
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('moving the budget-warn-pct range PATCHes the fraction', async () => {
    mockGet.mockResolvedValue(ON)
    renderWithQuery(<AutonomousOrgSection />)
    const range = await screen.findByTestId('autonomy-budgetWarnPct')
    // M-4: native range inputs default to browser-blue accent-color; the slider
    // must carry the same token-accent utility the sibling checkboxes already use.
    expect(range.className).toContain('accent-[var(--accent)]')
    fireEvent.change(range, { target: { value: '50' } })
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ budgetWarnPct: 0.5 }))
  })
})

describe('OrgPage — read-only autonomy status chip', () => {
  it('shows OFF when disabled, and navigates to settings on click', async () => {
    mockGet.mockResolvedValue(OFF)
    renderWithQuery(<OrgPage />)
    const chip = await screen.findByTestId('org-autonomy-chip')
    expect(chip.textContent).toContain('OFF')
    fireEvent.click(chip)
    expect(mockNavigate).toHaveBeenCalledWith('settings')
  })

  it('shows ON when enabled', async () => {
    mockGet.mockResolvedValue(ON)
    renderWithQuery(<OrgPage />)
    const chip = await screen.findByTestId('org-autonomy-chip')
    await waitFor(() => expect(chip.textContent).toContain('ON'))
  })
})
