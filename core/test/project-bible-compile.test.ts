import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { compileProjectBible, projectBibleSlug } from '../src/bible.js'
import { listArtifacts } from '../src/artifacts.js'

// ── temp helpers ────────────────────────────────────────────────────────────────

const tmps: string[] = []
function makeTmp(prefix = 'k-projbible-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Seed a minimal, real (authored) project bible under <localPath>/artifacts/bible/. */
function seedProjectBible(localPath: string): void {
  const sectionsDir = path.join(localPath, 'artifacts', 'bible', 'sections')
  fs.mkdirSync(sectionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(localPath, 'artifacts', 'bible', 'manifest.json'),
    JSON.stringify({
      title: 'Demo — Project Bible',
      project: { id: 'x', name: 'Demo', localPath: '.', githubRemote: null, bibleDir: 'artifacts/bible' },
      sections: ['01-vision'],
    }),
  )
  fs.writeFileSync(
    path.join(sectionsDir, '01-vision.md'),
    '---\ntitle: "Vision"\nicon: "◈"\nstatus: active\nupdated: 2026-07-02\n---\n\n## Purpose\n\nReal authored content here.\n',
  )
}

describe('compileProjectBible', () => {
  it('writes the served artifact + the in-repo composition, scoped to the project id', async () => {
    const localPath = makeTmp()
    const outDir = makeTmp('k-projbible-out-')
    seedProjectBible(localPath)
    const id = 'a4a062fb-4590-4bb7-8d11-8c1fdf099c05'

    const res = await compileProjectBible({ id, localPath }, outDir)
    expect(res).not.toBeNull()
    const slug = projectBibleSlug(id)

    // 1) served HTML lives under outDir as `${slug}.html` (getArtifact prefer-on-disk source)
    const servedPath = path.join(outDir, `${slug}.html`)
    expect(fs.existsSync(servedPath)).toBe(true)

    // 2) the in-repo composition is dropped at <localPath>/artifacts/project-bible.html
    const inRepoPath = path.join(localPath, 'artifacts', 'project-bible.html')
    expect(fs.existsSync(inRepoPath)).toBe(true)

    // 3) the artifact is upserted under the PROJECT-scoped slug (not the harness 'project-bible')
    const mine = listArtifacts().find(a => a.slug === slug)
    expect(mine).toBeDefined()
    expect(mine!.slug).not.toBe('project-bible')
    expect(mine!.tags).toContain('bible')

    // 4) served + in-repo are the SAME composition, and carry the authored content
    const served = fs.readFileSync(servedPath, 'utf8')
    const inRepo = fs.readFileSync(inRepoPath, 'utf8')
    expect(served).toBe(inRepo)
    expect(served).toContain('Real authored content here')
  })

  it('returns null when the project has no bible manifest (never onboarded/authored)', async () => {
    const localPath = makeTmp() // no artifacts/bible/
    const outDir = makeTmp('k-projbible-out-')
    const res = await compileProjectBible({ id: 'nomanifest', localPath }, outDir)
    expect(res).toBeNull()
    // nothing written to the project dir
    expect(fs.existsSync(path.join(localPath, 'artifacts', 'project-bible.html'))).toBe(false)
  })
})
