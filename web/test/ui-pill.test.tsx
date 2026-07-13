import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusPill } from '../src/ui/StatusPill'
import { Tag } from '../src/ui/Tag'

describe('StatusPill', () => {
  it('always renders a visible text label (never color-alone)', () => {
    render(<StatusPill status="done" />)
    expect(screen.getByText('done')).toBeTruthy()
  })
})
describe('Tag', () => {
  it('renders children and fires onDismiss', () => {
    const fn = vi.fn()
    render(<Tag onDismiss={fn}>claude-sonnet-4-6</Tag>)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(fn).toHaveBeenCalledOnce()
  })
})
