import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Dialog } from '../src/ui/Dialog'

describe('Dialog', () => {
  it('renders title + content when open, closes on ESC', () => {
    const onOpenChange = vi.fn()
    render(<Dialog open onOpenChange={onOpenChange} title="Confirm kill">body</Dialog>)
    expect(screen.getByRole('dialog', { name: 'Confirm kill' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
