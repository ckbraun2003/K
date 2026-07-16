// core/test/bible-self-project-dedupe.test.ts — BE-3e/DF-5: K registered as a project
// pointing at the harness repo itself produced TWO rows ('project-bible' +
// 'project-<id>-bible') with the same title, serving the SAME file. One row must win.
import { describe, it, expect, afterAll } from 'vitest'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db, artifactsDb, projectsDb } from '../src/db.js'
import { ARTIFACTS_DIR } from '../src/artifacts.js'
import { compileProjectBible, projectBibleSlug } from '../src/bible.js'

const projectId = randomUUID()
const selfRoot = path.resolve(ARTIFACTS_DIR, '..') // the harness repo root
const scopedSlug = projectBibleSlug(projectId)

afterAll(() => {
  db.prepare(`DELETE FROM artifacts WHERE slug = ?`).run(scopedSlug)
  db.prepare(`UPDATE artifacts SET project_id = NULL WHERE slug = 'project-bible'`).run()
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
})

describe('compileProjectBible self-repo dedupe', () => {
  it('a project whose localPath IS the harness repo compiles into the ONE project-bible row', async () => {
    // Requires the harness bible sources on disk (artifacts/bible/manifest.json —
    // always true in this repo); register the self-project row directly.
    projectsDb.insertProject.run({
      id: projectId, name: `self-${projectId.slice(0, 8)}`, localPath: selfRoot,
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
    })
    // a stale duplicate from the pre-fix world must be cleaned up by the compile
    artifactsDb.upsertArtifact.run({
      slug: scopedSlug, title: 'K — Project Bible', phase: null, status: 'active', tags: '[]',
      linkedRunId: null, updatedAt: Date.now(), md: 'stale', htmlPath: path.join(selfRoot, 'artifacts', 'project-bible.html'),
      projectId,
    })
    const res = await compileProjectBible({ id: projectId, localPath: selfRoot })
    expect(res).not.toBeNull()
    expect(artifactsDb.getArtifact.get(scopedSlug)).toBeUndefined()          // duplicate gone
    const harness = artifactsDb.getArtifact.get('project-bible') as Record<string, unknown>
    expect(harness).toBeDefined()
    expect(harness.project_id).toBe(projectId)                                // project tab still finds it
    const dupTitles = db.prepare(
      `SELECT COUNT(*) AS n FROM artifacts WHERE title = ? AND slug LIKE '%bible%'`,
    ).get(String(harness.title)) as { n: number }
    expect(dupTitles.n).toBe(1)                                               // one rail entry
  })
})
