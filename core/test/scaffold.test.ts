import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { scaffoldBible, scaffoldCi } from '../src/scaffold.js'
import { parseFrontmatter, roadmapPhases } from '../src/bible-parse.js'

// ── temp dir per test ─────────────────────────────────────────────────────────

const tmps: string[] = []

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-scaffold-'))
  tmps.push(d)
  return d
}

afterEach(() => {
  for (const d of tmps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

// ── scaffoldBible ─────────────────────────────────────────────────────────────

describe('scaffoldBible', () => {
  it('creates manifest + 5 section files and returns their paths', () => {
    const tmp = makeTmp()
    const created = scaffoldBible(tmp)

    // one manifest + five sections = 6 files
    expect(created).toHaveLength(6)
    expect(created).toContain('docs/bible/manifest.json')
    for (const id of ['01-vision','02-architecture','03-roadmap','04-decision-log','05-operations']) {
      expect(created).toContain(`docs/bible/sections/${id}.md`)
    }

    // all paths reported actually exist on disk
    for (const rel of created) {
      expect(fs.existsSync(path.join(tmp, ...rel.split('/')))).toBe(true)
    }
  })

  it('manifest.json is valid JSON with a sections array of length 5', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)
    const raw = fs.readFileSync(path.join(tmp, 'docs', 'bible', 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw)
    expect(Array.isArray(manifest.sections)).toBe(true)
    expect(manifest.sections).toHaveLength(5)
  })

  it('every section parses through parseFrontmatter with a non-empty title', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)
    const sectionsDir = path.join(tmp, 'docs', 'bible', 'sections')
    for (const file of fs.readdirSync(sectionsDir)) {
      const raw = fs.readFileSync(path.join(sectionsDir, file), 'utf8')
      const { meta } = parseFrontmatter(raw)
      expect(meta.title, `${file} should have a title`).toBeTruthy()
    }
  })

  it('roadmap section returns at least one phase with total >= 1', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)
    const raw = fs.readFileSync(
      path.join(tmp, 'docs', 'bible', 'sections', '03-roadmap.md'),
      'utf8'
    )
    const { body } = parseFrontmatter(raw)
    const phases = roadmapPhases(body)
    expect(phases.length).toBeGreaterThanOrEqual(1)
    expect(phases[0].total).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent: second call returns [] and does not overwrite files', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)

    // write a sentinel into the manifest before the second run
    const manifestPath = path.join(tmp, 'docs', 'bible', 'manifest.json')
    const sentinel = '/* sentinel */'
    fs.appendFileSync(manifestPath, sentinel)

    const second = scaffoldBible(tmp)
    expect(second).toEqual([])

    // sentinel must still be present (file was not overwritten)
    const content = fs.readFileSync(manifestPath, 'utf8')
    expect(content).toContain(sentinel)
  })

  it('only creates docs/ under tmp — nothing outside', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)
    const entries = fs.readdirSync(tmp)
    expect(entries).toEqual(['docs'])
  })
})

// ── scaffoldCi ────────────────────────────────────────────────────────────────

describe('scaffoldCi', () => {
  it('creates .github/workflows/ci.yml and returns its path', () => {
    const tmp = makeTmp()
    const created = scaffoldCi(tmp)
    expect(created).toEqual(['.github/workflows/ci.yml'])
    const ciPath = path.join(tmp, '.github', 'workflows', 'ci.yml')
    expect(fs.existsSync(ciPath)).toBe(true)
  })

  it('ci.yml is non-empty and contains required markers', () => {
    const tmp = makeTmp()
    scaffoldCi(tmp)
    const content = fs.readFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('jobs:')
    expect(content).toContain('pnpm install --frozen-lockfile')
    expect(content).toContain('ubuntu-latest')
    expect(content).toContain('node-version: 20')
  })

  it('is idempotent: second call returns [] and does not overwrite', () => {
    const tmp = makeTmp()
    scaffoldCi(tmp)

    const ciPath = path.join(tmp, '.github', 'workflows', 'ci.yml')
    const sentinel = '# sentinel\n'
    fs.appendFileSync(ciPath, sentinel)

    const second = scaffoldCi(tmp)
    expect(second).toEqual([])

    const content = fs.readFileSync(ciPath, 'utf8')
    expect(content).toContain(sentinel)
  })

  it('stack param is accepted without error (future-proofing)', () => {
    const tmp = makeTmp()
    expect(() => scaffoldCi(tmp, 'node')).not.toThrow()
    const tmp2 = makeTmp()
    expect(() => scaffoldCi(tmp2, 'python')).not.toThrow()
  })

  it('only creates .github/ under tmp — nothing outside', () => {
    const tmp = makeTmp()
    scaffoldCi(tmp)
    const entries = fs.readdirSync(tmp)
    expect(entries).toEqual(['.github'])
  })
})
