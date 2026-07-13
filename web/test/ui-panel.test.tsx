import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GlassPanel } from '../src/ui/GlassPanel'
import { SectionHeader } from '../src/ui/SectionHeader'

describe('GlassPanel', () => {
  it('maps tiers to tier classes', () => {
    const { container } = render(<GlassPanel tier="solid">x</GlassPanel>)
    expect(container.firstElementChild!.className).toContain('surface-solid')
  })
  it('interactive panels get lift affordance', () => {
    const { container } = render(<GlassPanel interactive>x</GlassPanel>)
    expect(container.firstElementChild!.className).toContain('card-lift')
  })
})

describe('SectionHeader', () => {
  it('renders label and count chip', () => {
    render(<SectionHeader label="Run list" count={5} />)
    expect(screen.getByText('Run list')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
  })
})
