// core/test/artifact-scan.test.ts — D-117 filesystem→registry sync.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db, artifactsDb, projectsDb } from '../src/db.js'
import { scanProjectArtifacts, scanHarnessArtifacts, resolveScannedFile } from '../src/artifact-scan.js'
import { listArtifacts, SLUG_RE } from '../src/artifacts.js'

let projectId: string
let root: string           // the project localPath
let artDir: string         // <localPath>/artifacts

function seedProject(): void {
  projectId = randomUUID()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'k-scan-'))
  artDir = path.join(root, 'artifacts')
  fs.mkdirSync(artDir, { recursive: true })
  projectsDb.insertProject.run({
    id: projectId, name: `scan-${projectId.slice(0, 8)}`, localPath: root,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
  })
}

const CLEANED: string[] = []
beforeEach(() => { seedProject(); CLEANED.push(projectId) })
afterAll(() => {
  for (const id of CLEANED) {
    db.prepare(`DELETE FROM artifacts WHERE project_id = ?`).run(id)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  }
})

describe('scanProjectArtifacts', () => {
  it('registers top-level *.html as scanned rows (title from <title>, else filename)', () => {
    fs.writeFileSync(path.join(artDir, 'perf-report.html'), '<!doctype html><title>Perf Report Q3</title><body>x</body>')
    fs.writeFileSync(path.join(artDir, 'no-title.html'), '<!doctype html><body>y</body>')
    fs.writeFileSync(path.join(artDir, 'notes.md'), '# not html')          // ignored
    fs.mkdirSync(path.join(artDir, 'sub'))
    fs.writeFileSync(path.join(artDir, 'sub', 'nested.html'), '<title>n</title>') // top-level only
    const r = scanProjectArtifacts(projectId)
    expect(r).toEqual({ added: 2, removed: 0, skipped: 0 })
    const rows = listArtifacts(projectId)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.origin).toBe('scanned')
      expect(row.projectId).toBe(projectId)
      expect(SLUG_RE.test(row.slug)).toBe(true)
      expect(row.slug.startsWith(`project-${projectId}-`)).toBe(true)
    }
    expect(rows.map(r2 => r2.title).sort()).toEqual(['Perf Report Q3', 'no-title'])
  })

  it('is idempotent (re-scan = 0 added, all skipped) and slugs stay within 80 chars', () => {
    const longBase = 'x'.repeat(120)
    fs.writeFileSync(path.join(artDir, `${longBase}.html`), '<title>long</title>')
    expect(scanProjectArtifacts(projectId).added).toBe(1)
    const again = scanProjectArtifacts(projectId)
    expect(again.added).toBe(0)
    expect(again.skipped).toBe(1)
    const slug = listArtifacts(projectId)[0].slug
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(SLUG_RE.test(slug)).toBe(true)
  })

  it('skips files that already back a compiled row html_path (bible never re-registered)', () => {
    const biblePath = path.join(artDir, 'project-bible.html')
    fs.writeFileSync(biblePath, '<title>K — Project Bible</title>')
    // simulate compileProjectBible's row: compiled origin, html_path → the file
    artifactsDb.upsertArtifact.run({
      slug: `project-${projectId}-bible`, title: 'K — Project Bible', phase: null, status: 'active',
      tags: '[]', linkedRunId: null, updatedAt: Date.now(), md: 'combined', htmlPath: biblePath,
      projectId,
    })
    const r = scanProjectArtifacts(projectId)
    expect(r.added).toBe(0)
    expect(r.skipped).toBe(1)
    // still exactly ONE bible row, still compiled
    const rows = listArtifacts(projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('compiled')
  })

  it('deletes scanned rows whose file vanished; never touches compiled rows', () => {
    fs.writeFileSync(path.join(artDir, 'gone.html'), '<title>g</title>')
    scanProjectArtifacts(projectId)
    fs.rmSync(path.join(artDir, 'gone.html'))
    // a compiled row whose html_path ALSO vanished must survive the sweep
    artifactsDb.upsertArtifact.run({
      slug: `project-${projectId}-bible`, title: 'b', phase: null, status: null, tags: '[]',
      linkedRunId: null, updatedAt: Date.now(), md: 'm', htmlPath: path.join(artDir, 'project-bible.html'),
      projectId,
    })
    const r = scanProjectArtifacts(projectId)
    expect(r.removed).toBe(1)
    const rows = listArtifacts(projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('compiled')
  })

  it('missing artifacts/ dir is a clean no-op', () => {
    fs.rmSync(artDir, { recursive: true })
    expect(scanProjectArtifacts(projectId)).toEqual({ added: 0, removed: 0, skipped: 0 })
  })
})

describe('path-escape rejection', () => {
  it('resolveScannedFile refuses any resolution outside the root', () => {
    // Windows backslash-separator escape only parses as a traversal on win32
    // (path.resolve on POSIX treats "C:\\proj\\artifacts" and "..\\evil.html" as
    // literal, non-separator characters, so it never actually escapes there —
    // the POSIX-separator case right below already proves the guard cross-platform).
    if (process.platform === 'win32') {
      expect(resolveScannedFile('C:\\proj\\artifacts', '..\\evil.html')).toBeNull()
    }
    expect(resolveScannedFile('/proj/artifacts', '../evil.html')).toBeNull()
    expect(resolveScannedFile(artDir, 'ok.html')).toBe(path.resolve(artDir, 'ok.html'))
  })
})

describe('scanHarnessArtifacts', () => {
  it('sweeps loose html in the given dir into harness-scoped (projectId null) scanned rows, skipping slug-owned files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-harness-scan-'))
    try {
      fs.writeFileSync(path.join(dir, 'mobile-ui-demo.html'), '<title>Mobile UI Demo</title>')
      // a file whose basename IS an existing artifact slug (served via the
      // ARTIFACTS_DIR/<slug>.html fallback) must be skipped, not double-registered
      artifactsDb.upsertArtifact.run({
        slug: 'ui-demo', title: 'demo', phase: null, status: 'active', tags: '[]',
        linkedRunId: null, updatedAt: Date.now(), md: 'm', htmlPath: null, projectId: null,
      })
      fs.writeFileSync(path.join(dir, 'ui-demo.html'), '<title>demo</title>')
      const r = scanHarnessArtifacts(dir)
      expect(r.added).toBe(1)
      expect(r.skipped).toBe(1)
      const all = listArtifacts()
      const scanned = all.find(a => a.slug === 'mobile-ui-demo')
      expect(scanned?.origin).toBe('scanned')
      expect(scanned?.projectId).toBeNull()
      db.prepare(`DELETE FROM artifacts WHERE slug IN ('mobile-ui-demo','ui-demo')`).run()
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
  })
})
