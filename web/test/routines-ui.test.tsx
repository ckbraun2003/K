/**
 * AutomationsTab — E-16 routines first-class. Locks: a schedule-triggered routine
 * row shows its measured cost + a next-run label sourced from api.routines.list;
 * the create form's cron field gains an NL→cron helper (api.routines.parseCron)
 * that fills the cron field on success and surfaces an inline error on failure.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Skill, RoutineView } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockSkillsList, mockEvals, mockRuns, mockProjects, mockRoutinesList, mockParseCron } = vi.hoisted(() => ({
  mockSkillsList: vi.fn(), mockEvals: vi.fn(), mockRuns: vi.fn(), mockProjects: vi.fn(),
  mockRoutinesList: vi.fn(), mockParseCron: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    skills: { list: mockSkillsList, evals: mockEvals, runs: mockRuns },
    projects: { list: mockProjects },
    routines: { list: mockRoutinesList, parseCron: mockParseCron },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import AutomationsTab from '../src/pages/skills/AutomationsTab'

const skill: Skill = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'nightly-verify', type: 'skill', source: 'do things',
  triggerType: 'schedule', schedule: '0 9 * * *', enabled: true, createdAt: 0,
}

const routine: RoutineView = {
  id: skill.id, name: skill.name, enabled: true, schedule: '0 9 * * *',
  nextRunAt: Date.now() + 3 * 3600_000, lastRunAt: Date.now() - 86_400_000,
  runs: 4, totalCostUsd: 1.2345, pipelineDefId: null,
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AutomationsTab />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSkillsList.mockResolvedValue([skill])
  mockEvals.mockResolvedValue([])
  mockRuns.mockResolvedValue([])
  mockProjects.mockResolvedValue([])
  mockRoutinesList.mockResolvedValue([routine])
})
afterEach(() => cleanup())

describe('AutomationsTab — routine row', () => {
  it('shows measured cost + a next-run label for a schedule-triggered routine', async () => {
    renderTab()
    const cost = await screen.findByTestId('routine-cost')
    expect(cost.textContent).toContain('$1.23')
    expect(screen.getByTestId('routine-next-run').textContent).toMatch(/next run/i)
  })
})

describe('AutomationsTab — pipeline-targeted routine badge (review fix)', () => {
  it('shows a "→ pipeline" badge when the routine carries a pipelineDefId', async () => {
    mockRoutinesList.mockResolvedValue([{ ...routine, pipelineDefId: 'pl-def-1' }])
    renderTab()
    await screen.findByTestId('routine-cost')
    expect(screen.getByText('→ pipeline')).toBeTruthy()
  })

  it('shows no pipeline badge for a plain (non-pipeline) routine', async () => {
    renderTab()
    await screen.findByTestId('routine-cost')
    expect(screen.queryByText('→ pipeline')).toBeNull()
  })
})

describe('AutomationsTab — NL→cron', () => {
  it('a valid phrase fills the create-form cron field', async () => {
    mockParseCron.mockResolvedValue({ cron: '0 9 * * *' })
    renderTab()
    fireEvent.click(screen.getByText('+ add skill'))
    fireEvent.change(screen.getByTestId('skill-trigger-select'), { target: { value: 'schedule' } })
    fireEvent.change(screen.getByTestId('routine-nl-input'), { target: { value: 'every day at 9am' } })
    fireEvent.click(screen.getByTestId('routine-nl-submit'))
    await waitFor(() => expect(mockParseCron).toHaveBeenCalledWith('every day at 9am'))
    await waitFor(() =>
      expect((screen.getByTestId('skill-cron-input') as HTMLInputElement).value).toBe('0 9 * * *'),
    )
  })

  it('an unmappable phrase surfaces an inline error, no crash', async () => {
    mockParseCron.mockRejectedValue(new Error('could not derive a valid cron from "whenever"'))
    renderTab()
    fireEvent.click(screen.getByText('+ add skill'))
    fireEvent.change(screen.getByTestId('skill-trigger-select'), { target: { value: 'schedule' } })
    fireEvent.change(screen.getByTestId('routine-nl-input'), { target: { value: 'whenever' } })
    fireEvent.click(screen.getByTestId('routine-nl-submit'))
    const err = await screen.findByTestId('cron-error')
    expect(err.textContent).toContain('could not derive a valid cron')
  })
})
