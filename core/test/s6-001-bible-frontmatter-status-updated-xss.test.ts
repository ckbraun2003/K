/**
 * REGRESSION — FAULT S6-001 (FIXED + promoted to gating, reboot wave F1.W3).
 * Finding: testing/findings/S6-voice-bible.md → row S6-001.
 *
 * Stored XSS in the compiled bible via UNESCAPED frontmatter fields.
 *
 *   Surface: core/src/bible.ts :: bibleTemplate.
 *     - body badge:   `<span class="badge badge-...">${s.status}</span>`        (raw)
 *     - nav title:    `<span ... title="${s.status}">`                           (raw)
 *     - body updated: `<span class="section-updated mono">updated ${s.updated}</span>` (raw)
 *   s.status / s.updated come straight from a section's frontmatter (compileBible
 *   lines ~365-367). Unlike `title` and `icon` (both escHtml'd) and the markdown
 *   BODY (sanitizeRenderedHtml'd), these two template fields are interpolated
 *   verbatim. A section file is exactly the untrusted agent/user `.md` content the
 *   sanitizer exists to neutralise — so a malicious `status:`/`updated:` value
 *   injects a live <script>/onerror into the persisted, browser-opened bible HTML.
 *
 *   Reachable from: bible recompile of any project whose section frontmatter an
 *   agent/operator can write (artifacts/bible or docs/bible). The existing
 *   sanitize.test.ts only injects into `icon` (escaped) and the body (sanitized),
 *   leaving status/updated untested.
 *
 *   Expected: status/updated are HTML-escaped like title/icon — the payload shows
 *             as inert text (`&lt;script&gt;…`), no executable tag survives.
 *   Was:      the raw <script>/<img onerror> appeared verbatim in the compiled HTML.
 *
 * FIXED: bibleTemplate now escHtml()'s s.status (badge + nav title) and s.updated,
 * mirroring the existing escHtml(s.title)/escHtml(s.icon) — the payloads render as
 * inert text. This test asserts that EXPECTED (safe) behavior → now GREEN and gates.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { compileBible } from '../src/bible.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** Compile a single-section bible whose frontmatter carries the given fields. */
async function compileWith(frontmatter: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `k-s6-001-${uuid().slice(0, 8)}-`))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ title: 'B', project: { id: 'p', name: 'P', bibleDir: 'docs/bible' }, sections: ['01-x'] }),
  )
  fs.writeFileSync(path.join(dir, 'sections', '01-x.md'), `---\n${frontmatter}\n---\n\n# Benign heading\n\nbody`)
  const out = path.join(dir, 'out.html')
  const r = await compileBible(dir, out)
  expect(r).not.toBeNull()
  return fs.readFileSync(r!.htmlPath, 'utf8')
}

describe('S6-001: frontmatter `status` must be HTML-escaped in the compiled bible', () => {
  it('a <script> in `status` is neutralised (escaped), not emitted live', async () => {
    const html = await compileWith('title: Safe\nstatus: <script>alert(1)</script>\nupdated: 2026-01-01')
    // EXPECTED (safe): escaped to inert text, like the icon field already is.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)')
  })

  it('an attribute-breakout `status` cannot inject a tag via the nav title="" attr', async () => {
    const html = await compileWith('title: Safe\nstatus: x"><script>alert(2)</script>\nupdated: 2026-01-01')
    expect(html).not.toContain('<script>alert(2)</script>')
  })
})

describe('S6-001: frontmatter `updated` must be HTML-escaped in the compiled bible', () => {
  it('an <img onerror> in `updated` is neutralised (escaped), not emitted live', async () => {
    const html = await compileWith('title: Safe\nstatus: draft\nupdated: <img src=x onerror=alert(7)>')
    // EXPECTED (safe): escaped to inert text — the LIVE <img onerror> tag is gone
    // (mirrors the `status` <script> assertions above). escHtml leaves the inert
    // attribute *text* `onerror=alert(7)` inside `&lt;img …&gt;`, which is harmless
    // — the angle brackets are entities, so no element/handler is ever parsed.
    expect(html).not.toContain('<img src=x onerror=alert(7)>')
    // Pin the full single-escaped payload (s.updated is escHtml'd once, not run
    // through marked), mirroring the sibling `status` test's `&lt;script&gt;…`.
    expect(html).toContain('&lt;img src=x onerror=alert(7)&gt;')
  })
})
