// core/test/bible-template-overflow.test.ts — DF-1: the 1440×900 audit showed the
// compiled bible clipping text mid-word behind a horizontal scrollbar. Root cause:
// `.layout { grid-template-columns: 272px 1fr }` — a grid track's min size defaults
// to min-content, so wide unbreakable content (long inline code tokens, wide table
// cells) pushes the 1fr column past the viewport. pre{} was already contained
// (overflow-x: auto); inline code and table cells were not.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db } from '../src/db.js'
import { compileBible } from '../src/bible.js'
import { renderMdToHtml } from '../src/artifacts.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k-bible-overflow-'))
afterAll(() => {
  db.prepare(`DELETE FROM artifacts WHERE slug = 'overflow-test-bible'`).run()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

function seedBible(): string {
  const dir = path.join(tmp, 'bible')
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    title: 'T', project: { id: 'x', name: 'x', bibleDir: 'bible' }, sections: ['01-a'],
  }))
  fs.writeFileSync(path.join(dir, 'sections', '01-a.md'),
    `---\ntitle: A\nicon: "S"\nstatus: draft\nupdated: 2026-07-14\n---\n\n` +
    '`' + 'C:\\very\\long\\unbreakable\\path\\'.repeat(12) + '`\n')
  return dir
}

describe('DF-1 template overflow guards', () => {
  it('compiled bible CSS constrains the content track and wraps unbreakable content', async () => {
    const out = path.join(tmp, 'out.html')
    const res = await compileBible(seedBible(), out, { slug: 'overflow-test-bible' })
    expect(res).not.toBeNull()
    const html = fs.readFileSync(out, 'utf8')
    expect(html).toContain('minmax(0, 1fr)')
    expect(html).toContain('min-width: 0')
    expect(html).toContain('overflow-wrap: anywhere')
    expect(html).not.toMatch(/grid-template-columns:\s*272px 1fr;/)
  })

  it('generic artifact template carries the same guards', async () => {
    const html = await renderMdToHtml('# t\n\n`' + 'x'.repeat(400) + '`', 't')
    expect(html).toContain('minmax(0, 1fr)')
    expect(html).toContain('min-width: 0')
    expect(html).toContain('overflow-wrap: anywhere')
  })
})
