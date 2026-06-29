/**
 * REGRESSION (red by design) — Finding S6-002.
 *
 * The bible compiler interpolates the section `slug` RAW into three HTML
 * attributes without escaping:
 *
 *   Surface: core/src/bible.ts :: bibleTemplate
 *     - nav:  `href="#${s.slug}" data-section="${s.slug}"`
 *     - body: `<section id="${s.slug}" ...>`
 *
 * `slug` is a `manifest.sections[]` entry that must also name a real
 * `sections/<slug>.md` file. The escaping is simply wrong: an HTML-significant
 * char in the slug lands unescaped in attribute context. We demonstrate with
 * `&` (a LEGAL Windows/POSIX filename char): the slug `s&p` produces `id="s&p"`
 * where the spec requires `id="s&amp;p"`.
 *
 * LATENCY NOTE: full attribute-breakout XSS needs `"`/`<`/`>` in the slug, which
 * are ILLEGAL in Windows filenames (so script-exec via slug is latent on
 * Windows) but LEGAL on POSIX (reachable there for anyone controlling the
 * manifest + section files). The `&` case below is the cross-platform-reproducible
 * proof that the slug sinks are unescaped; the higher-severity breakout shares
 * the same root cause/fix.
 *
 *   Expected: slug is HTML-escaped (escHtml) in id/href/data-section attributes.
 *   Actual:   slug is emitted verbatim (`id="s&p"`).
 *
 * Asserts the EXPECTED (safe) behavior → RED. Flips green when bible.ts escapes
 * (or slugifies) s.slug in all three sinks.
 *
 * Finding row: testing/findings/S6-voice-bible.md  (S6-002)
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { compileBible } from '../../src/bible.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('S6-002: section slug must be HTML-escaped in id/href/data-section attributes', () => {
  it('a slug containing "&" is escaped to "&amp;" in the compiled attributes', async () => {
    const slug = 's&p'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `k-s6-002-${uuid().slice(0, 8)}-`))
    tmpDirs.push(dir)
    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ title: 'B', project: { id: 'p', name: 'P', bibleDir: 'docs/bible' }, sections: [slug] }),
    )
    fs.writeFileSync(path.join(dir, 'sections', `${slug}.md`), '---\ntitle: SP\n---\nbody')

    const out = path.join(dir, 'out.html')
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    const html = fs.readFileSync(r!.htmlPath, 'utf8')

    // EXPECTED (safe): escaped ampersand in the attribute value.
    expect(html).toContain('id="s&amp;p"')
    // CURRENT (fault): raw `id="s&p"` (and href="#s&p", data-section="s&p").
    expect(html).not.toContain('id="s&p"')
  })
})
