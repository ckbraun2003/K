import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import GlassFilterDefs, { LG_REFRACT_SCALE } from '../src/components/GlassFilterDefs'

describe('GlassFilterDefs (LG2 refraction)', () => {
  it('renders the one #lg-refract filter def (turbulence + displacement)', () => {
    const { container } = render(<GlassFilterDefs />)
    const filter = container.querySelector('filter')
    expect(filter?.getAttribute('id')).toBe('lg-refract')
    // getElementsByTagName is case-exact for SVG in jsdom (querySelector is not)
    expect(filter?.getElementsByTagName('feTurbulence').length).toBe(1)
    const disp = filter?.getElementsByTagName('feDisplacementMap')[0]
    expect(disp?.getAttribute('scale')).toBe(String(LG_REFRACT_SCALE))
  })
  it('pins the scale literal to the --lg-refract-scale token value', () => {
    expect(LG_REFRACT_SCALE).toBe(14)
  })
})
