import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button, IconButton } from '../src/ui/Button'

describe('Button', () => {
  it('fires onClick, shows spinner and blocks clicks when loading', () => {
    const fn = vi.fn()
    const { rerender } = render(<Button onClick={fn}>Go</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(fn).toHaveBeenCalledOnce()
    rerender(<Button onClick={fn} loading>Go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(fn).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toBeTruthy()
  })
  it('IconButton requires and exposes an accessible label', () => {
    render(<IconButton name="trash" label="Delete run" />)
    expect(screen.getByRole('button', { name: 'Delete run' })).toBeTruthy()
  })
})
