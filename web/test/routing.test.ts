import { describe, it, expect } from 'vitest'
import { formatLatency, formatSuccessRate, formatCost } from '../src/pages/RoutingPage'

describe('formatLatency', () => {
  it('formats sub-second as ms (rounded)', () => {
    expect(formatLatency(840)).toBe('840ms')
    expect(formatLatency(0)).toBe('0ms')
    expect(formatLatency(840.6)).toBe('841ms')
  })

  it('formats >= 1s with one decimal', () => {
    expect(formatLatency(1000)).toBe('1.0s')
    expect(formatLatency(1200)).toBe('1.2s')
    expect(formatLatency(12_340)).toBe('12.3s')
  })

  it('renders em-dash for negative / non-finite', () => {
    expect(formatLatency(-1)).toBe('—')
    expect(formatLatency(NaN)).toBe('—')
    expect(formatLatency(Infinity)).toBe('—')
  })
})

describe('formatSuccessRate', () => {
  it('formats 0..1 as a rounded percent', () => {
    expect(formatSuccessRate(0.92)).toBe('92%')
    expect(formatSuccessRate(1)).toBe('100%')
    expect(formatSuccessRate(0)).toBe('0%')
    expect(formatSuccessRate(0.005)).toBe('1%')
  })

  it('renders em-dash for non-finite', () => {
    expect(formatSuccessRate(NaN)).toBe('—')
  })
})

describe('formatCost', () => {
  it('renders a bare $0 for zero', () => {
    expect(formatCost(0)).toBe('$0')
  })

  it('uses 4dp under $1', () => {
    expect(formatCost(0.0123)).toBe('$0.0123')
    expect(formatCost(0.5)).toBe('$0.5000')
  })

  it('uses 2dp at/above $1', () => {
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(10)).toBe('$10.00')
  })

  it('renders em-dash for non-finite', () => {
    expect(formatCost(Infinity)).toBe('—')
  })
})
