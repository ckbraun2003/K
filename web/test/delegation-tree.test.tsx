import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DelegationNode } from '@k/shared'
import DelegationTree from '../src/components/DelegationTree'

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

/** A 3-level org root: Chief → one lead → two sub-agents. */
function root(): DelegationNode {
  return {
    id: 'chief',
    label: 'Chief',
    kind: 'chief',
    status: 'running',
    meta: '1 lead · 1 active',
    children: [
      {
        id: 'lead-backend',
        label: 'Backend',
        kind: 'lead',
        status: 'running',
        meta: 'Ship the auth refactor',
        children: [
          { id: 'c1', label: 'implementer', kind: 'sub-agent', status: 'done', meta: 'Build wave', children: [] },
          { id: 'c2', label: 'spec-review', kind: 'sub-agent', status: 'running', children: [] },
        ],
      },
    ],
  }
}

describe('DelegationTree', () => {
  it('renders the root and every descendant node (arbitrary depth)', () => {
    render(<DelegationTree root={root()} />)
    expect(screen.getByTestId('delegation-tree-node-chief').textContent).toContain('Chief')
    expect(screen.getByTestId('delegation-tree-node-lead-backend').textContent).toContain('Backend')
    const sub = screen.getByTestId('delegation-tree-node-c1')
    expect(sub.textContent).toContain('implementer')
    expect(sub.textContent).toContain('done')
    expect(screen.getByTestId('delegation-tree-node-c2').textContent).toContain('spec-review')
  })

  it('defaults the inspector to the root, then updates it when a node is selected', async () => {
    const user = userEvent.setup()
    render(<DelegationTree root={root()} />)

    // default selection is the root → its meta shown, a sub-agent's not.
    const detail = screen.getByTestId('delegation-node-detail')
    expect(detail.textContent).toContain('Chief')
    expect(detail.textContent).not.toContain('Build wave')

    // select the leaf sub-agent → inspector reflects it.
    await user.click(screen.getByTestId('delegation-tree-node-c1'))
    const updated = screen.getByTestId('delegation-node-detail')
    expect(updated.textContent).toContain('implementer')
    expect(updated.textContent).toContain('Build wave')
  })

  it('shows the selected node\'s children summary', async () => {
    const user = userEvent.setup()
    render(<DelegationTree root={root()} />)
    // select the lead → its two children are summarized in the inspector.
    await user.click(screen.getByTestId('delegation-tree-node-lead-backend'))
    const detail = screen.getByTestId('delegation-node-detail')
    expect(detail.textContent).toContain('Children (2)')
    expect(detail.textContent).toContain('implementer')
    expect(detail.textContent).toContain('spec-review')
  })

  it('renders the whole-org chain — user → K → Chief → lead → sub-agent — all visible', () => {
    // The multi-tier root (loop-b2): the two ancestor tiers wrap the Chief subtree.
    const whole: DelegationNode = {
      id: 'user',
      label: 'Operator',
      kind: 'user',
      status: 'idle',
      meta: 'the front door → the whole org',
      children: [
        {
          id: 'k',
          label: 'K',
          kind: 'secretary',
          status: 'running',
          meta: 'secretary front door · 3 delegations to Chief',
          children: [root()],
        },
      ],
    }
    render(<DelegationTree root={whole} />)
    // Every tier of the chain is present in the DOM (the §13 visibility contract).
    expect(screen.getByTestId('delegation-tree-node-user').textContent).toContain('Operator')
    expect(screen.getByTestId('delegation-tree-node-k').textContent).toContain('K')
    expect(screen.getByTestId('delegation-tree-node-chief').textContent).toContain('Chief')
    expect(screen.getByTestId('delegation-tree-node-lead-backend').textContent).toContain('Backend')
    expect(screen.getByTestId('delegation-tree-node-c1').textContent).toContain('implementer')
  })
})
