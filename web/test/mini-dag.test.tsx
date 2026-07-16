import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MiniDag from '../src/components/MiniDag'

describe('MiniDag', () => {
  it('renders one chip per role with connectors between', () => {
    const { container } = render(<MiniDag roles={['architect', 'implementer', 'reviewer']} />)
    for (const r of ['architect', 'implementer', 'reviewer']) expect(screen.getByText(r)).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="dag-edge"]').length).toBe(2)
  })
  it('renders nothing for an empty chain', () => {
    const { container } = render(<MiniDag roles={[]} />)
    expect(container.firstElementChild).toBeNull()
  })
})
