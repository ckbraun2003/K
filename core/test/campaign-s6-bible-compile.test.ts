/**
 * S6 — Bible compiler robustness + recovery (LOCK / gating).
 *
 * Exercises compileBible against malformed/empty/missing frontmatter, missing
 * section files, absent manifest, @live: directive resolution (incl. unknown
 * names), duplicate titles, and recovery-from-a-corrupt-compiled-artifact +
 * determinism. All compiles run under a UNIQUE temp dir (never the real
 * artifacts/ or docs/bible/). @live:stats reads the SUITE-WIDE `runs` table
 * (one K_DATA_DIR is shared by every core test file), so an empty table is NOT
 * guaranteed — the @live:stats test asserts the branch that matches the actual
 * run count (and that the directive is always resolved, never raw/injected).
 *
 * NOTE (S6-012, observation): compileBible has NO separate backup mechanism — it
 * overwrites the prior HTML in place. That is acceptable because the compiled
 * HTML is a DERIVED artifact: the sections/manifest are the source of truth, so
 * "recovery from a corrupt compiled artifact" == recompile from the intact
 * source. These tests lock that recovery path. XSS in the compiled output via
 * unescaped frontmatter status/updated/slug is a CONFIRMED FAULT — see the
 * S6-001/S6-002 quarantine tests, not here.
 *
 * Findings: S6-009 (frontmatter degrade), S6-010 (missing sections / no
 * manifest), S6-011 (@live directives), S6-012 (recovery + determinism),
 * S6-014 (duplicate titles). testing/findings/S6-voice-bible.md.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { compileBible } from '../src/bible.js'
import { db } from '../src/db.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

interface ScaffoldOpts {
  files?: Record<string, string>   // slug -> raw .md content
  manifestSlugs?: string[]         // overrides manifest.sections (default: Object.keys(files))
  withManifest?: boolean           // default true
  title?: string
}

/** Build an isolated bible source dir under os.tmpdir(). Returns { dir, out }. */
function scaffold(opts: ScaffoldOpts): { dir: string; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `k-s6-bible-${uuid().slice(0, 8)}-`))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true })
  const files = opts.files ?? {}
  if (opts.withManifest !== false) {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        title: opts.title ?? 'Test Bible',
        project: { id: 'p', name: 'Proj', bibleDir: 'docs/bible' },
        sections: opts.manifestSlugs ?? Object.keys(files),
      }),
    )
  }
  for (const [slug, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'sections', `${slug}.md`), body)
  }
  return { dir, out: path.join(dir, 'out.html') }
}

const maskCompiledAt = (html: string) =>
  html.replace(/compiled <span class="mono">[^<]*<\/span>/, 'compiled <span class="mono">X</span>')

// ── Frontmatter degradation (S6-009) ───────────────────────────────────────────

describe('S6 compileBible — malformed/empty/missing frontmatter degrades, never throws', () => {
  it('section with NO frontmatter falls back to slug title / draft status / — updated', async () => {
    const { dir, out } = scaffold({ files: { '01-plain': '# Heading\n\nsome body text' } })
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    // title falls back to the slug; status badge falls back to draft (amber)
    expect(html).toContain('01-plain')
    expect(html).toContain('>draft<')
    expect(html).toContain('updated —')
  })

  it('frontmatter with NO closing --- is treated as no-frontmatter (no throw)', async () => {
    const { dir, out } = scaffold({ files: { '01-bad': '---\ntitle: X\n\n# Body' } })
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    expect(r!.sections).toEqual(['01-bad'])
  })

  it('empty frontmatter block compiles with all fallbacks', async () => {
    const { dir, out } = scaffold({ files: { '01-empty': '---\n---\nbody' } })
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).toContain('01-empty')
  })
})

// ── Missing sections / absent manifest (S6-010) ─────────────────────────────────

describe('S6 compileBible — missing sections & absent manifest', () => {
  it('a manifest slug with no .md file is skipped; other sections still compile', async () => {
    const { dir, out } = scaffold({
      files: { 'a': '---\ntitle: A\n---\nalpha' },
      manifestSlugs: ['a', 'ghost'], // "ghost" has no file
    })
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    expect(r!.sections).toEqual(['a']) // ghost omitted
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).toContain('alpha')
  })

  it('ALL sections missing → still returns a result and writes a valid HTML doc', async () => {
    const { dir, out } = scaffold({ files: {}, manifestSlugs: ['x', 'y'] })
    const r = await compileBible(dir, out)
    expect(r).not.toBeNull()
    expect(r!.sections).toEqual([])
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('no manifest at all → returns null and writes nothing', async () => {
    const { dir, out } = scaffold({ withManifest: false, files: {} })
    const r = await compileBible(dir, out)
    expect(r).toBeNull()
    expect(fs.existsSync(out)).toBe(false)
  })
})

// ── @live: directives (S6-011) ─────────────────────────────────────────────────

describe('S6 compileBible — @live: directive resolution is safe', () => {
  it('an UNKNOWN directive name resolves to a safe placeholder (no injection)', async () => {
    const { dir, out } = scaffold({
      files: { '01-live': '---\ntitle: Live\n---\n\n<!-- @live:bogus -->' },
    })
    const r = await compileBible(dir, out)
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).toContain('no bogus data')
  })

  it('@live:stats resolves to the live block matching the runs table (empty → placeholder)', async () => {
    const { dir, out } = scaffold({
      files: { '01-stats': '---\ntitle: Stats\n---\n\n<!-- @live:stats -->' },
    })
    const r = await compileBible(dir, out)
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    // The directive is ALWAYS resolved — never the raw comment, never injection.
    expect(html).not.toContain('@live:stats')
    // liveStats() = `SELECT COUNT(*) FROM runs` over the suite-wide DB, so assert
    // the branch matching the actual count (deterministic regardless of file order).
    const runs = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
    if (runs === 0) {
      expect(html).toContain('live-empty')
      expect(html).toContain('no run data')   // substring of "— no run data yet —"
    } else {
      expect(html).toContain('live-stats')
      expect(html).toContain('TOTAL RUNS')
    }
  })

  it('a directive name carrying HTML does not match the [\\w-] grammar → no script injected', async () => {
    const { dir, out } = scaffold({
      files: { '01-inj': '---\ntitle: Inj\n---\n\n<!-- @live:<script>alert(42)</script> -->' },
    })
    const r = await compileBible(dir, out)
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).not.toContain('alert(42)')
  })
})

// ── Duplicate titles (S6-014) ───────────────────────────────────────────────────

describe('S6 compileBible — duplicate section TITLES (distinct slugs) compile fine', () => {
  it('two distinct slugs sharing a title both render', async () => {
    const { dir, out } = scaffold({
      files: {
        'a': '---\ntitle: Same Title\n---\nalpha',
        'b': '---\ntitle: Same Title\n---\nbeta',
      },
      manifestSlugs: ['a', 'b'],
    })
    const r = await compileBible(dir, out)
    expect(r!.sections).toEqual(['a', 'b'])
    const html = fs.readFileSync(r!.htmlPath, 'utf8')
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
  })
})

// ── Recovery + determinism (S6-012) ─────────────────────────────────────────────

describe('S6 compileBible — recovery from a corrupt compiled artifact + determinism', () => {
  const files = {
    '01-vision': '---\ntitle: Vision\nstatus: stable\nupdated: 2026-01-01\n---\n\n# Vision\n\nthe plan',
    '02-roadmap': '---\ntitle: Roadmap\nstatus: active\nupdated: 2026-01-02\n---\n\n## Phase 0\n- [x] done\n- [ ] todo',
  }

  it('recompiling from intact source faithfully recovers a corrupted compiled HTML', async () => {
    const { dir, out } = scaffold({ files, manifestSlugs: ['01-vision', '02-roadmap'] })
    const r1 = await compileBible(dir, out)
    expect(r1).not.toBeNull()

    // Corrupt the compiled artifact in place (simulates a truncated/garbage write).
    fs.writeFileSync(out, 'GARBAGE-NOT-HTML')
    expect(fs.readFileSync(out, 'utf8')).toBe('GARBAGE-NOT-HTML')

    // Recovery == recompile from the (intact) source of truth.
    const r2 = await compileBible(dir, out)
    expect(r2).not.toBeNull()
    const html2 = fs.readFileSync(r2!.htmlPath, 'utf8')
    expect(html2).toContain('<!DOCTYPE html>')
    expect(html2).not.toContain('GARBAGE-NOT-HTML')
    expect(html2).toContain('Vision')
    expect(html2).toContain('Roadmap')
  })

  it('output is deterministic except for the compiledAt timestamp (modulo @live data)', async () => {
    const { dir, out } = scaffold({ files, manifestSlugs: ['01-vision', '02-roadmap'] })
    await compileBible(dir, out)
    const a = fs.readFileSync(out, 'utf8')
    const out2 = path.join(dir, 'out2.html')
    await compileBible(dir, out2)
    const b = fs.readFileSync(out2, 'utf8')
    expect(maskCompiledAt(a)).toBe(maskCompiledAt(b))
  })
})
