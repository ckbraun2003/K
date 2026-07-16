import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Checkbox } from '../src/ui/Field'

afterEach(() => cleanup())

describe('Checkbox', () => {
  it('renders the one filled field skin and toggles', () => {
    const fn = vi.fn()
    render(<Checkbox aria-label="Auto-merge" checked={false} onChange={fn} />)
    const box = screen.getByLabelText('Auto-merge')
    expect(box.className).toContain('accent-accent')
    expect(box.className).toContain('rounded')
    fireEvent.click(box)
    expect(fn).toHaveBeenCalledOnce()
  })
})
