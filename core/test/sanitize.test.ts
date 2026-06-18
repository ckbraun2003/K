/**
 * A3 regression — stored XSS in compiled bible / artifact HTML.
 *
 * Markdown (and section icons) are untrusted. After marked() rendering the body
 * must be sanitized: <script>, onerror= handlers, and javascript: URLs are
 * neutralised, while ordinary formatting (headings, lists, code, links, tables)
 * survives. Covers both the artifacts renderer and the bible compiler.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sanitizeRenderedHtml } from '../src/sanitize.js'
import { renderMdToHtml } from '../src/artifacts.js'
import { compileBible } from '../src/bible.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Raw HTML XSS embedded in markdown. marked() passes raw HTML through verbatim,
// so the sanitizer is the only thing standing between this and the page.
const XSS = '<script>alert(1)</script>\n\n<img src=x onerror="alert(3)">\n\n<a href="javascript:alert(4)">link</a>'

describe('sanitizeRenderedHtml', () => {
  it('strips <script> and onerror= while keeping safe formatting', () => {
    const dirty = '<h1>Title</h1><script>alert(1)</script><img src=x onerror="alert(2)"><p>ok</p>'
    const clean = sanitizeRenderedHtml(dirty)
    expect(clean).not.toContain('<script>')
    expect(clean).not.toContain('onerror')
    expect(clean).toContain('<h1>Title</h1>')
    expect(clean).toContain('<p>ok</p>')
  })

  it('drops javascript: URLs but keeps https links', () => {
    const clean = sanitizeRenderedHtml('<a href="javascript:alert(1)">x</a><a href="https://ok.test">y</a>')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('https://ok.test')
  })

  it('keeps GFM task-list checkboxes', () => {
    const clean = sanitizeRenderedHtml('<input type="checkbox" checked disabled>')
    expect(clean).toContain('type="checkbox"')
  })
})

describe('renderMdToHtml — artifact XSS neutralised', () => {
  it('compiles malicious markdown without an executable script or onerror handler', async () => {
    const html = await renderMdToHtml(`# Heading\n\n- item\n\n${XSS}`, 'T')
    // injected sinks neutralised
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('javascript:')
    // normal formatting survives
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<li>item</li>')
  })
})

describe('compileBible — section XSS neutralised', () => {
  it('compiles a malicious section + icon without <script>/onerror in the body', async () => {
    const bibleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-bible-xss-'))
    tmpDirs.push(bibleDir)
    fs.mkdirSync(path.join(bibleDir, 'sections'), { recursive: true })
    fs.writeFileSync(
      path.join(bibleDir, 'manifest.json'),
      JSON.stringify({
        title: 'XSS Bible',
        project: { id: 'x', name: 'x', bibleDir: 'docs/bible' },
        sections: ['01-evil'],
      }),
    )
    fs.writeFileSync(
      path.join(bibleDir, 'sections', '01-evil.md'),
      `---\ntitle: "Evil"\nicon: "<script>alert(9)</script>"\nstatus: draft\nupdated: 2026-01-01\n---\n\n# Normal heading\n\n${XSS}`,
    )

    const result = await compileBible(bibleDir)
    expect(result).not.toBeNull()
    const html = fs.readFileSync(result!.htmlPath, 'utf8')

    // the compiled page must not contain an executable script or inline handler
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('javascript:')
    // escaped icon shows up as text, not a live tag
    expect(html).toContain('&lt;script&gt;')
    // ordinary markdown still rendered
    expect(html).toContain('Normal heading')
  })
})
