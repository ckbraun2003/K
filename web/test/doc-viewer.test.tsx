/**
 * DocViewer — F-042: in an `.html` bible, clicking a TOC `#anchor` blanked the whole
 * srcDoc iframe (it navigated the parent SPA, tripping ~6 CORS errors) because a
 * sandboxed srcDoc resolves bare fragments against the parent URL. `withInDocBase`
 * injects `<base href="about:srcdoc">` so fragments resolve IN-document (scroll,
 * not navigate). Tests the pure transform + that the rendered iframe carries it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { withInDocBase } from '../src/components/DocViewer'

describe('withInDocBase (F-042)', () => {
  it('injects an in-doc base just after <head> so #anchors stay in the iframe', () => {
    const out = withInDocBase('<html><head><title>T</title></head><body><a href="#03-x">x</a></body></html>')
    expect(out).toContain('<base href="about:srcdoc">')
    // The base must land inside <head>, before the title.
    expect(out.indexOf('<base')).toBeGreaterThan(out.indexOf('<head'))
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title'))
  })

  it('falls back to after <html> when there is no head', () => {
    const out = withInDocBase('<html><body>hi</body></html>')
    expect(out).toContain('<base href="about:srcdoc">')
    expect(out.indexOf('<base')).toBeGreaterThan(out.indexOf('<html'))
  })

  it('prepends when there is neither head nor html', () => {
    const out = withInDocBase('<p>bare</p>')
    expect(out.startsWith('<base href="about:srcdoc">')).toBe(true)
  })

  it('leaves a document that already declares a base untouched', () => {
    const html = '<head><base href="/x"></head><body>y</body>'
    expect(withInDocBase(html)).toBe(html)
  })
})

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { artifacts: { get: mockGet } } }))
import DocViewer from '../src/components/DocViewer'

function renderViewer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DocViewer slug="bible" />
    </QueryClientProvider>,
  )
}

const artifact: Artifact = {
  slug: 'bible', title: 'Bible', tags: [], updatedAt: 0,
  md: '# Bible',
  html: '<html><head></head><body><a href="#03-foo">§3</a><h2 id="03-foo">3</h2></body></html>',
}

beforeEach(() => { mockGet.mockReset(); mockGet.mockResolvedValue(artifact) })
afterEach(() => cleanup())

describe('DocViewer html view', () => {
  it('renders the html iframe with the in-doc base injected (anchors cannot escape to the parent)', async () => {
    renderViewer()
    const iframe = (await screen.findByTitle('Bible')) as HTMLIFrameElement
    expect(iframe.getAttribute('srcdoc')).toContain('<base href="about:srcdoc">')
  })
})

describe('DocViewer markdown view (FU-5)', () => {
  it('wraps ReactMarkdown output in the .doc-markdown token-CSS class, never the inert Tailwind-Typography prose-* classes', async () => {
    const { container } = renderViewer()
    await screen.findByTitle('Bible') // default view is 'html' — wait for the first render to settle
    fireEvent.click(screen.getByText('.md'))
    const wrapper = await screen.findByText('Bible', { selector: 'h1' })
    const markdownRoot = wrapper.closest('.doc-markdown')
    expect(markdownRoot).toBeTruthy()
    expect(markdownRoot?.className).not.toMatch(/\bprose\b/)
  })
})
