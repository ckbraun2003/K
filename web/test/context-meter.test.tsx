import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import ContextMeter from '../src/components/ContextMeter'
import type { ContextPressure } from '../src/lib/context'

afterEach(() => cleanup())

function pressure(over: Partial<ContextPressure>): ContextPressure {
  return { tokens: 0, limit: 200_000, percent: 0, band: 'ok', ...over }
}

describe('ContextMeter — known limit', () => {
  it('renders the compact ctx label + percent', () => {
    render(<ContextMeter pressure={pressure({ tokens: 142_000, percent: 71, band: 'warn' })} />)
    const meter = screen.getByTestId('context-meter')
    expect(meter.textContent).toContain('ctx 142k / 200k · 71%')
  })

  it('ok band uses the green fill', () => {
    render(<ContextMeter pressure={pressure({ tokens: 20_000, percent: 10, band: 'ok' })} />)
    expect(screen.getByTestId('context-meter-fill').className).toContain('bg-[var(--green)]')
  })

  it('warn band uses the amber fill', () => {
    render(<ContextMeter pressure={pressure({ tokens: 150_000, percent: 75, band: 'warn' })} />)
    expect(screen.getByTestId('context-meter-fill').className).toContain('bg-[var(--amber)]')
  })

  it('danger band uses the red fill', () => {
    render(<ContextMeter pressure={pressure({ tokens: 190_000, percent: 95, band: 'danger' })} />)
    expect(screen.getByTestId('context-meter-fill').className).toContain('bg-[var(--red)]')
  })

  it('exposes an accessible label including the percent and token counts', () => {
    render(<ContextMeter pressure={pressure({ tokens: 142_000, percent: 71, band: 'warn' })} />)
    const meter = screen.getByTestId('context-meter')
    expect(meter.getAttribute('role')).toBe('img')
    expect(meter.getAttribute('aria-label')).toBe('Context usage 71% (142000 of 200000 tokens)')
  })

  it('rounds a fractional percent for display + label', () => {
    render(<ContextMeter pressure={pressure({ tokens: 138_500, percent: 69.25, band: 'ok' })} />)
    const meter = screen.getByTestId('context-meter')
    expect(meter.textContent).toContain('· 69%')
    expect(meter.getAttribute('aria-label')).toContain('Context usage 69%')
  })
})

describe('ContextMeter — unknown limit', () => {
  it('shows a muted dash, no percent, no bar', () => {
    render(<ContextMeter pressure={pressure({ tokens: 9000, limit: undefined, percent: undefined, band: 'unknown' })} />)
    const meter = screen.getByTestId('context-meter')
    expect(meter.textContent).toContain('—')
    expect(meter.textContent).not.toContain('%')
    expect(screen.queryByTestId('context-meter-fill')).toBeNull()
  })

  it('has the unknown accessible label + an explanatory title', () => {
    render(<ContextMeter pressure={pressure({ limit: undefined, percent: undefined, band: 'unknown' })} />)
    const meter = screen.getByTestId('context-meter')
    expect(meter.getAttribute('aria-label')).toBe('Context usage unknown')
    expect(meter.getAttribute('title')).toBeTruthy()
  })
})
