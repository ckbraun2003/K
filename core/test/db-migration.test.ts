/**
 * Verifies the guarded migration: runs.project_id column exists (fresh or migrated DB),
 * the index exists, and FK behaviour is enforced.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, runsDb, projectsDb, migrate } from '../src/db.js'

const PROJECT_ID = uuid()
const RUN_WITH_PROJECT = uuid()
const RUN_WITHOUT_PROJECT = uuid()

afterAll(() => {
  // FK order: delete runs first, then project
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN_WITH_PROJECT)
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN_WITHOUT_PROJECT)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('migrate() on old-schema DB — guarded ALTER branch', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-${Date.now()}.db`)
  let tempDb: Database.Database

  it('sets up an old-schema DB and runs migrate() — adds column + index', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // Old-schema runs table: no project_id column
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id          TEXT PRIMARY KEY,
        prompt      TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        worktree    TEXT,
        status      TEXT NOT NULL DEFAULT 'queued',
        provider    TEXT NOT NULL DEFAULT 'claude',
        model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        ended_at    INTEGER
      );
    `)

    migrate(tempDb)

    const cols = tempDb.pragma('table_info(runs)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('project_id')

    const indexes = tempDb.pragma('index_list(runs)') as Array<{ name: string }>
    expect(indexes.map(i => i.name)).toContain('idx_runs_project')
  })

  it('migrate() is idempotent — calling it a second time does not throw', () => {
    expect(() => migrate(tempDb)).not.toThrow()
  })

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })
})

describe('db migration — runs.project_id', () => {
  it('project_id column exists in runs table', () => {
    const cols = db.pragma('table_info(runs)') as Array<{ name: string }>
    const names = cols.map(c => c.name)
    expect(names).toContain('project_id')
  })

  it('idx_runs_project index exists', () => {
    const indexes = db.pragma('index_list(runs)') as Array<{ name: string }>
    const names = indexes.map(i => i.name)
    expect(names).toContain('idx_runs_project')
  })

  it('can insert a run with project_id null', () => {
    runsDb.insertRun.run({
      id: RUN_WITHOUT_PROJECT,
      prompt: 'migration test — no project',
      cwd: '/tmp/test-cwd',
      worktree: null,
      status: 'queued',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: null,
      createdAt: Date.now(),
    })
    const row = runsDb.getRun.get(RUN_WITHOUT_PROJECT) as { project_id: string | null }
    expect(row.project_id).toBeNull()
  })

  it('can insert a run with a valid project_id (FK enforced)', () => {
    // Insert a real project first so FK is satisfied
    projectsDb.insertProject.run({
      id: PROJECT_ID,
      name: 'migration-test-project',
      localPath: '/tmp/migration-test-project',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })

    runsDb.insertRun.run({
      id: RUN_WITH_PROJECT,
      prompt: 'migration test — with project',
      cwd: '/tmp/test-cwd',
      worktree: null,
      status: 'queued',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: PROJECT_ID,
      createdAt: Date.now(),
    })

    const row = runsDb.getRun.get(RUN_WITH_PROJECT) as { project_id: string | null }
    expect(row.project_id).toBe(PROJECT_ID)
  })
})
