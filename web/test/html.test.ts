import { describe, it, expect } from 'vitest'
import { stripScripts } from '../src/lib/html'

describe('stripScripts', () => {
  it('removes a paired script block and its contents', () => {
    const html = '<h1>Bible</h1><script>const x = 1; doThing()</script><p>body</p>'
    const out = stripScripts(html)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('doThing')
    expect(out).toContain('<h1>Bible</h1>')
    expect(out).toContain('<p>body</p>')
  })

  it('removes multiple scripts and is case/attribute insensitive', () => {
    const html = '<SCRIPT type="module">a</SCRIPT>x<script defer>b</script>'
    expect(stripScripts(html)).toBe('x')
  })

  it('handles multiline script bodies (scroll-spy / j-k nav)', () => {
    const html = `<body>doc<script>\n  const items = [...document.querySelectorAll('.nav-item')]\n  // ...\n</script></body>`
    const out = stripScripts(html)
    expect(out).toBe('<body>doc</body>')
  })

  it('removes a stray unclosed/self-closed script tag', () => {
    expect(stripScripts('a<script src="x.js"/>b')).toBe('ab')
  })

  it('leaves script-free html untouched', () => {
    const html = '<main><h2>section</h2><p>no scripts here</p></main>'
    expect(stripScripts(html)).toBe(html)
  })

  it('passes through empty input', () => {
    expect(stripScripts('')).toBe('')
  })
})
