import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KpiTile } from '../src/ui/KpiTile'

describe('KpiTile', () => {
  it('colors delta by polarity, not by sign', () => {
    const { rerender } = render(<KpiTile label="Cost" value="$2.08" delta={{ pct: 33, polarity: 'badUp' }} />)
    expect(screen.getByText('+33%').className).toContain('text-red')
    rerender(<KpiTile label="Success" value="46%" delta={{ pct: 42, polarity: 'goodUp' }} />)
    expect(screen.getByText('+42%').className).toContain('text-green')
  })

  it('M-1: a flat (0%) delta reads as neutral, not good or bad', () => {
    render(<KpiTile label="Cost" value="$2.08" delta={{ pct: 0, polarity: 'badUp' }} />)
    const el = screen.getByText('0%')
    expect(el.className).toContain('text-muted')
    expect(el.className).not.toContain('text-red')
    expect(el.className).not.toContain('text-green')
  })
})
