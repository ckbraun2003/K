/**
 * F-034 — a PROJECT bible recompile is a NOTICED, SCOPED write.
 *
 * compileProjectBible legitimately regenerates a git-TRACKED deliverable
 * (<localPath>/artifacts/project-bible.html, tracked since e903f5c so a fresh clone
 * serves a real bible). The H2 concern: a recompile must touch ONLY that one
 * designated artifact — never other tracked files in the repo. These tests assert
 * the scoping in code (the only file written under the project is project-bible.html)
 * and that the result carries the written path (so the dirty tree isn't a surprise).
 *
 * Reuses the production db singleton (upsertArtifact) and cleans its row in afterAll.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { compileProjectBible, projectBibleSlug } from '../src/bible.js'
import { isPathWithin } from '../src/paths.js'
import { db } from '../src/db.js'

const tmpDirs: string[] = []
const slugs: string[] = []

afterAll(() => {
  for (const s of slugs) {
    try { db.prepare('DELETE FROM artifacts WHERE slug = ?').run(s) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** A project repo with an authored bible under artifacts/bible/ PLUS other files
 *  (src/, README, an existing tracked artifact) that a recompile must NOT touch. */
function makeProjectRepo(): { id: string; localPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k-f034-'))
  tmpDirs.push(root)
  const bibleDir = path.join(root, 'artifacts', 'bible', 'sections')
  fs.mkdirSync(bibleDir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'artifacts', 'bible', 'manifest.json'),
    JSON.stringify({
      title: 'Proj Bible',
      project: { id: 'p', name: 'Proj', bibleDir: 'artifacts/bible' },
      sections: ['01-vision'],
    }),
  )
  fs.writeFileSync(path.join(bibleDir, '01-vision.md'), '---\ntitle: Vision\nstatus: stable\nupdated: 2026-01-01\n---\n\n# Vision\n\nthe plan')
  // Unrelated tracked files a scoped recompile must leave byte-for-byte intact.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n')
  fs.writeFileSync(path.join(root, 'artifacts', 'other.txt'), 'keep me\n')
  const id = uuid()
  slugs.push(projectBibleSlug(id))
  return { id, localPath: root }
}

/** Every file under `root` → its content, for a before/after diff. */
function snapshot(root: string): Map<string, string> {
  const m = new Map<string, string>()
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else m.set(path.relative(root, abs), fs.readFileSync(abs, 'utf8'))
    }
  }
  walk(root)
  return m
}

describe('F-034: compileProjectBible writes ONLY the designated tracked artifact', () => {
  it('creates artifacts/project-bible.html and touches no other file; result reports the path', async () => {
    const project = makeProjectRepo()
    const before = snapshot(project.localPath)

    const result = await compileProjectBible(project)
    expect(result).not.toBeNull()

    // (a) the ONE designated tracked deliverable was written, under the project's artifacts dir.
    const htmlPath = path.join(project.localPath, 'artifacts', 'project-bible.html')
    expect(result!.htmlPath).toBe(htmlPath)
    expect(fs.existsSync(htmlPath)).toBe(true)
    expect(isPathWithin(path.join(project.localPath, 'artifacts'), result!.htmlPath)).toBe(true)

    // (b) the recompile is SCOPED: the ONLY new file under the repo is project-bible.html,
    //     and every pre-existing file is byte-for-byte unchanged (no collateral writes).
    const after = snapshot(project.localPath)
    const added = [...after.keys()].filter(k => !before.has(k))
    expect(added).toEqual([path.join('artifacts', 'project-bible.html')])
    for (const [rel, content] of before) {
      expect(after.get(rel), `${rel} must be untouched`).toBe(content)
    }
  })

  it('re-running the recompile still only rewrites project-bible.html (idempotent scope)', async () => {
    const project = makeProjectRepo()
    await compileProjectBible(project)
    const before = snapshot(project.localPath)
    await compileProjectBible(project)
    const after = snapshot(project.localPath)
    // Same file set; only project-bible.html may differ (its compiledAt timestamp).
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [rel, content] of before) {
      if (rel === path.join('artifacts', 'project-bible.html')) continue
      expect(after.get(rel), `${rel} must be untouched on re-recompile`).toBe(content)
    }
  })
})
