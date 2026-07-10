import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DELEGATION_WORKFLOW, type Run } from '@k/shared'
import WorkflowDiagram from '../src/components/WorkflowDiagram'
import RunTree from '../src/components/RunTree'
import { filterPickerRuns } from '../src/pages/runs/WorkflowsView'
import type { WorkflowTree } from '../src/lib/workflow'

// jsdom has no matchMedia; framer-motion may probe it. Provide an inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => cleanup())

// ─── Static defined-workflow diagram ─────────────────────────────────────────

describe('WorkflowDiagram', () => {
  it('renders all four role labels', () => {
    render(<WorkflowDiagram />)
    for (const role of DELEGATION_WORKFLOW.roles) {
      expect(screen.getByText(role.label)).toBeTruthy()
    }
  })

  it('shows a role description only after the role is clicked', async () => {
    const user = userEvent.setup()
    const { container } = render(<WorkflowDiagram />)
    const implementer = DELEGATION_WORKFLOW.roles.find(r => r.id === 'implementer')!

    // collapsed: description not shown yet
    expect(container.textContent).not.toContain(implementer.description)

    await user.click(screen.getByTestId('role-implementer'))
    expect(screen.getByTestId('role-detail').textContent).toContain(implementer.description)
  })
})

// ─── Run-picker identity filter (C2) ─────────────────────────────────────────

function pickerRun(id: string): Run {
  return {
    id, prompt: `run ${id}`, cwd: '/repo', status: 'done', provider: 'claude',
    model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0,
  }
}

describe('filterPickerRuns', () => {
  const runs = [pickerRun('r1'), pickerRun('r2'), pickerRun('r3')]
  const workflowIds = new Set(['r2'])

  it('workflow-only mode keeps only runs backed by a workflow_runs row', () => {
    expect(filterPickerRuns(runs, workflowIds, false).map(r => r.id)).toEqual(['r2'])
  })

  it('showAll returns every run unchanged (order preserved)', () => {
    expect(filterPickerRuns(runs, workflowIds, true)).toEqual(runs)
  })

  it('empty identity set → empty filtered list (the "toggle All runs" hint case)', () => {
    expect(filterPickerRuns(runs, new Set(), false)).toEqual([])
    expect(filterPickerRuns([], workflowIds, false)).toEqual([])
  })
})

// ─── Live runtime tree ───────────────────────────────────────────────────────

function tree(): WorkflowTree {
  return {
    root: { runId: 'run-1', label: 'My batch run', status: 'running' },
    children: [
      { id: 'c1', agentType: 'implementer', label: 'Build wave', status: 'done', prompt: 'implement the feature', result: 'all done' },
      { id: 'c2', agentType: 'spec-review', label: 'Spec check', status: 'running', prompt: 'review the spec', result: '' },
    ],
  }
}

describe('RunTree', () => {
  it('renders the root and each child with its status', () => {
    render(<RunTree tree={tree()} />)
    expect(screen.getByTestId('run-tree-root').textContent).toContain('My batch run')
    const c1 = screen.getByTestId('run-tree-child-c1')
    const c2 = screen.getByTestId('run-tree-child-c2')
    expect(c1.textContent).toContain('implementer')
    expect(c1.textContent).toContain('done')
    expect(c2.textContent).toContain('spec-review')
    expect(c2.textContent).toContain('running')
  })

  it('selects a child and reveals its prompt + result', async () => {
    const user = userEvent.setup()
    render(<RunTree tree={tree()} />)

    // default selection is the root → run prompt visible, child prompt not
    expect(screen.getByTestId('node-detail').textContent).toContain('My batch run')
    expect(screen.getByTestId('node-detail').textContent).not.toContain('implement the feature')

    await user.click(screen.getByTestId('run-tree-child-c1'))
    const detail = screen.getByTestId('node-detail')
    expect(detail.textContent).toContain('implement the feature')
    expect(detail.textContent).toContain('all done')
  })

  it('shows an empty state when the run spawned no sub-agents', () => {
    render(<RunTree tree={{ root: { runId: 'r', label: 'p', status: 'done' }, children: [] }} />)
    expect(screen.getByTestId('run-tree-empty').textContent).toContain('no sub-agents')
  })
})
