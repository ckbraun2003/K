/**
 * P4 Task 10 (C3) — E-11 run-status adoption sweep. Locks that the Lane-C
 * surfaces migrated off their ad-hoc status maps onto the canonical
 * `runStatusMeta` (web/src/lib/status.ts): the class strings a surface renders
 * must be exactly what the canonical module computes for that status. Expected
 * values are DERIVED from runStatusMeta (not hard-coded), so a future palette
 * change to the canonical module keeps these green without edits.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run, Skill, GithubStatus } from '@k/shared'
import type { WorkflowTree } from '../src/lib/workflow'
import type { SkillRun } from '../src/lib/skill-runs'
import { runStatusMeta, agentRunStatusMeta } from '../src/lib/status'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const {
  mockVerifications, mockRunsList, mockGithub, mockProjectsList,
  mockSkillsList, mockSkillEvals, mockSkillRuns, mockNavigate,
  mockRoutinesList, mockParseCron,
} = vi.hoisted(() => ({
  mockVerifications: vi.fn(),
  mockRunsList: vi.fn(),
  mockGithub: vi.fn(),
  mockProjectsList: vi.fn(),
  mockSkillsList: vi.fn(),
  mockSkillEvals: vi.fn(),
  mockSkillRuns: vi.fn(),
  mockNavigate: vi.fn(),
  mockRoutinesList: vi.fn(),
  mockParseCron: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: {
      verifications: mockVerifications,
      github: mockGithub,
      list: mockProjectsList,
      verify: vi.fn(),
      onboard: vi.fn(),
    },
    runs: { list: mockRunsList },
    skills: { list: mockSkillsList, evals: mockSkillEvals, runs: mockSkillRuns },
    // E-16 — AutomationsTab unconditionally loads routines.
    routines: { list: mockRoutinesList, parseCron: mockParseCron },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import RunTree from '../src/components/RunTree'
import OverviewTab from '../src/pages/tabs/OverviewTab'
import AutomationsTab from '../src/pages/skills/AutomationsTab'

function renderWithClient(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

/** Every whitespace-split class token of `expected` must appear in `actual`. */
function expectHasTokens(actual: string, expected: string) {
  for (const tok of expected.split(/\s+/).filter(Boolean)) {
    expect(actual.includes(tok)).toBe(true)
  }
}

const github: GithubStatus = { prs: [], ci: [], fetchedAt: Date.now() }

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifications.mockResolvedValue([])
  mockRunsList.mockResolvedValue([] as Run[])
  mockGithub.mockResolvedValue(github)
  mockProjectsList.mockResolvedValue([])
  mockSkillsList.mockResolvedValue([])
  mockSkillEvals.mockResolvedValue([])
  mockSkillRuns.mockResolvedValue([])
  mockRoutinesList.mockResolvedValue([])
})
afterEach(() => cleanup())

// ── 1. RunTree — root + child borders come from runStatusMeta(.border). ───────
describe('RunTree — E-11 border adoption', () => {
  it('paints root + child nodes with runStatusMeta(status).border', () => {
    const tree: WorkflowTree = {
      root: { runId: 'r', label: 'batch', status: 'error' },
      children: [{ id: 'c1', agentType: 'implementer', label: 'x', status: 'running', prompt: '', result: '' }],
    }
    renderWithClient(<RunTree tree={tree} />)

    expectHasTokens(screen.getByTestId('run-tree-root').className, runStatusMeta('error').border)
    expectHasTokens(screen.getByTestId('run-tree-child-c1').className, runStatusMeta('running').border)
  })
})

// ── 2. OverviewTab — the recent-run status dot uses runStatusMeta(.dot). ──────
describe('OverviewTab — E-11 status dot adoption', () => {
  it('a running run row renders the canonical live dot (incl. glow-live)', async () => {
    const runningRun: Run = {
      id: '22222222-2222-2222-2222-222222222222',
      prompt: 'do the thing',
      cwd: '/p',
      status: 'running',
      provider: 'claude',
      model: 'claude-x',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      createdAt: Date.now(),
    }
    mockRunsList.mockResolvedValue([runningRun])

    renderWithClient(<OverviewTab projectId="p1" />)

    const label = await screen.findByText('do the thing')
    const dot = label.closest('button')!.querySelector('.rounded-full') as HTMLElement
    expect(dot).toBeTruthy()
    expectHasTokens(dot.className, runStatusMeta('running').dot)
  })
})

// ── 3. AutomationsTab — skill-run history badge uses agentRunStatusMeta(.badge). ─
// skill_runs use the AGENT-RUN vocabulary (running/completed/failed), NOT RunStatus —
// 'completed'/'failed' are the NORMAL terminal states and must render (and not crash the
// canonicalizer, which has no default branch for out-of-RunStatus values).
describe('AutomationsTab — E-11 run-history badge adoption', () => {
  const skill: Skill = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'nightly-verify', type: 'skill', source: 'do things',
    triggerType: 'manual', enabled: true, createdAt: 0,
  }
  function skillRun(id: string, status: string, startedAt: number): SkillRun {
    return { id, skillId: skill.id, runId: null, triggeredBy: 'manual', startedAt, completedAt: null, status }
  }

  it('running + completed skill-runs render the canonical agent-run badges (no crash on terminal states)', async () => {
    mockSkillsList.mockResolvedValue([skill])
    mockSkillRuns.mockResolvedValue([skillRun('sr1', 'running', 2000), skillRun('sr2', 'completed', 1000)])

    renderWithClient(<AutomationsTab />)

    fireEvent.click(await screen.findByTestId('skill-history-toggle'))
    const history = await screen.findByTestId('skill-run-history')
    expectHasTokens((await within(history).findByText('running')).className, agentRunStatusMeta('running').badge)
    // 'completed' is the terminal state the old cast crashed on — must render green, not throw.
    expectHasTokens((await within(history).findByText('completed')).className, agentRunStatusMeta('completed').badge)
  })
})
