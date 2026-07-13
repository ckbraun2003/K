import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Icon, ICONS } from '../src/ui/Icon'

describe('Icon', () => {
  it('renders an svg for every semantic name', () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const { container, unmount } = render(<Icon name={name} />)
      expect(container.querySelector('svg'), name).toBeTruthy()
      unmount()
    }
  })
  it('is aria-hidden by default but labellable', () => {
    const { container } = render(<Icon name="runs" label="Runs" />)
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Runs')
  })
})
