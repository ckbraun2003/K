/**
 * P0 carry-in #4 — parseVerifyRecipe's SCHEMA-INVALID branch: VALID JSON that
 * fails VerifyRecipeSchema (empty commands) must read back as undefined,
 * distinct from the malformed-JSON branch already covered in db-migration-v8.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db, projectsDb } from '../src/db.js'
import { getProject } from '../src/projects.js'

describe('parseVerifyRecipe schema-invalid branch', () => {
  it('valid JSON failing VerifyRecipeSchema → verifyRecipe undefined', () => {
    const id = randomUUID()
    projectsDb.insertProject.run({ id, name: `vri-${id.slice(0, 8)}`, localPath: process.cwd(),
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    db.prepare(`UPDATE projects SET verify_recipe = ? WHERE id = ?`).run(JSON.stringify({ commands: [] }), id)
    expect(getProject(id)?.verifyRecipe).toBeUndefined()
    db.prepare(`UPDATE projects SET verify_recipe = ? WHERE id = ?`).run(JSON.stringify({ commands: [{ label: '', run: '' }] }), id)
    expect(getProject(id)?.verifyRecipe).toBeUndefined()
  })
})
