import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import Markdown from '../src/components/Markdown'

describe('Markdown (DF-3)', () => {
  it('renders **bold** and ## headings as elements, not literals', () => {
    const { container } = render(<Markdown text={'## Leads\n\n**Leads:** frontend, backend'} />)
    expect(container.querySelector('h2')?.textContent).toBe('Leads')
    expect(container.querySelector('strong')?.textContent).toBe('Leads:')
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('##')
  })
  it('never injects raw HTML (sanitized)', () => {
    const { container } = render(<Markdown text={'hi <script>window.x=1</script> <img src=x onerror=alert(1)>'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
  it('renders fenced code as a styled block', () => {
    const { container } = render(<Markdown text={'```\nconst a = 1\n```'} />)
    expect(container.querySelector('pre code')).toBeTruthy()
  })
})
