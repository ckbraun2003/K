import { describe, it, expect, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { compileProjectBible, projectBibleSlug } from '../src/bible.js'
import { listArtifacts, getArtifact, ARTIFACTS_DIR } from '../src/artifacts.js'
import { db, projectsDb } from '../src/db.js'

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

// v13 (D-117): compileProjectBible stamps artifacts.project_id (an FK), so the
// project must EXIST — as it always does in production (routes resolve via
// getProject before compiling).
const seededProjects: string[] = []
function seedProjectRow(id: string, localPath: string): void {
  // Idempotent across runs: this file uses FIXED ids, and the shared vitest data
  // dir persists between runs — clear any stale rows before inserting.
  try { db.prepare('DELETE FROM artifacts WHERE project_id = ?').run(id) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  projectsDb.insertProject.run({
    id, name: `projbible-${id.slice(0, 8)}`, localPath,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
  })
  seededProjects.push(id)
}
afterAll(() => {
  for (const id of seededProjects) {
    try { db.prepare('DELETE FROM artifacts WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
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
  it('compiles into the PROJECT dir and serves it from there — never K/ARTIFACTS_DIR', async () => {
    const localPath = makeTmp()
    seedProjectBible(localPath)
    const id = 'a4a062fb-4590-4bb7-8d11-8c1fdf099c05'
    seedProjectRow(id, localPath)

    const res = await compileProjectBible({ id, localPath })
    expect(res).not.toBeNull()
    const slug = projectBibleSlug(id)

    // 1) the composed HTML is written to the project's OWN artifacts/project-bible.html —
    //    the single source of truth, and the CompileResult points at it.
    const inRepoPath = path.join(localPath, 'artifacts', 'project-bible.html')
    expect(fs.existsSync(inRepoPath)).toBe(true)
    expect(res!.htmlPath).toBe(inRepoPath)

    // 2) NOTHING is copied into K's ARTIFACTS_DIR — a project's artifacts stay in the project.
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.html`))).toBe(false)

    // 3) the artifact is upserted under the PROJECT-scoped slug (not the harness 'project-bible')
    const mine = listArtifacts().find(a => a.slug === slug)
    expect(mine).toBeDefined()
    expect(mine!.slug).not.toBe('project-bible')
    expect(mine!.tags).toContain('bible')

    // 4) getArtifact serves the project's own composition VERBATIM (via html_path),
    //    carrying the authored content.
    const served = await getArtifact(slug)
    expect(served).not.toBeNull()
    expect(served!.html).toBe(fs.readFileSync(inRepoPath, 'utf8'))
    expect(served!.html).toContain('Real authored content here')
  })

  it('returns null when the project has no bible manifest (never onboarded/authored)', async () => {
    const localPath = makeTmp() // no artifacts/bible/
    const res = await compileProjectBible({ id: 'nomanifest', localPath })
    expect(res).toBeNull()
    // nothing written to the project dir
    expect(fs.existsSync(path.join(localPath, 'artifacts', 'project-bible.html'))).toBe(false)
  })

  it('getArtifact degrades to a generic md render when the html_path file is gone', async () => {
    const localPath = makeTmp()
    seedProjectBible(localPath)
    const id = 'b1b1b1b1-0000-4000-8000-000000000001'
    seedProjectRow(id, localPath)
    await compileProjectBible({ id, localPath })
    const slug = projectBibleSlug(id)
    const inRepoPath = path.join(localPath, 'artifacts', 'project-bible.html')

    // Simulate the composed file being moved/deleted out from under the row.
    fs.rmSync(inRepoPath)
    // Neither the html_path source nor ARTIFACTS_DIR/<slug>.html exists → md fallback.
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.html`))).toBe(false)

    const served = await getArtifact(slug)
    expect(served).not.toBeNull()
    // still serves (no crash / no 404), carrying the authored content…
    expect(served!.html).toContain('Real authored content here')
    // …but as the GENERIC render, not the rich bible template (no scroll-spy nav).
    expect(served!.html).not.toContain('nav-item')
  })
})
