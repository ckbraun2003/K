/**
 * P5.1d2a — collapse tests (the D-026 storage unification, deferred half).
 *
 * The RISKIEST half: project_tasks folds into work_items (scope='project') behind
 * UNCHANGED routes/helpers. These tests pin the NEW storage behavior; the sibling
 * p5-1d-characterization.test.ts pins the observable route/sync contract that must
 * stay green THROUGH this collapse. Two flavors, mirroring db-migration.test.ts /
 * p5-1d-work-item-scope.test.ts:
 *   - old-schema tempDbs (Database from 'better-sqlite3', os.tmpdir) exercise the
 *     migrate() column-add + backfill + hasTable guards in isolation.
 *   - the live `db` singleton + projectWorkItemsDb exercise the re-pointed helpers and
 *     the deleteProject cleanup end-to-end. All live rows are cleaned in afterAll.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, projectsDb, projectWorkItemsDb, migrate } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem } from '@k/shared'

// ── live db: the work_items project columns + index exist after migrate() ──────

describe('P5.1d2: work_items gains the project columns + index', () => {
  it('table_info(work_items) has the collapsed project_tasks columns', () => {
    const cols = (db.pragma('table_info(work_items)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('project_id')
    expect(cols).toContain('completed_at')
    expect(cols).toContain('issue_number')
    expect(cols).toContain('issue_url')
    expect(cols).toContain('issue_state')
  })

  it('idx_work_items_project index exists', () => {
    const idx = (db.pragma('index_list(work_items)') as Array<{ name: string }>).map(i => i.name)
    expect(idx).toContain('idx_work_items_project')
  })
})

// ── migrate(): backfill a seeded project_tasks row into work_items ─────────────

describe('P5.1d2: migrate() backfills project_tasks → work_items (idempotently)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-p51d2-backfill-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('copies a done project_tasks row (metadata preserved, scope project, run_id null) and is idempotent', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // Old-schema DB: projects+runs (migrate()'s unconditional runs ALTER needs them),
    // a PRE-collapse work_items (no scope / no project cols — migrate adds them), and
    // a project_tasks table carrying the full issue-sync metadata.
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        worktree TEXT, status TEXT NOT NULL DEFAULT 'queued',
        provider TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE work_items (
        id          TEXT PRIMARY KEY,
        run_id      TEXT,
        title       TEXT NOT NULL,
        body        TEXT,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE project_tasks (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'open',
        created_at   INTEGER NOT NULL,
        completed_at INTEGER,
        issue_number INTEGER,
        issue_url    TEXT,
        issue_state  TEXT
      );
    `)

    const projectId = uuid()
    const taskId = uuid()
    tempDb.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
    tempDb
      .prepare(`INSERT INTO project_tasks
        (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
        VALUES (?, ?, 'legacy task', 'done', 1000, 2000, 42, 'https://gh/issues/42', 'CLOSED')`)
      .run(taskId, projectId)

    expect(() => migrate(tempDb)).not.toThrow()

    const row = tempDb.prepare(`SELECT * FROM work_items WHERE id = ?`).get(taskId) as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.scope).toBe('project')
    expect(row.project_id).toBe(projectId)
    expect(row.title).toBe('legacy task')
    expect(row.status).toBe('done')
    expect(row.created_at).toBe(1000)
    // updated_at reuses created_at on backfill (the old project_tasks store had none).
    expect(row.updated_at).toBe(1000)
    expect(row.completed_at).toBe(2000)
    expect(row.issue_number).toBe(42)
    expect(row.issue_url).toBe('https://gh/issues/42')
    expect(row.issue_state).toBe('CLOSED')
    expect(row.run_id).toBeNull()

    // Second migrate() must NOT duplicate (NOT EXISTS keys on the reused id).
    expect(() => migrate(tempDb)).not.toThrow()
    const count = tempDb.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE id = ?`).get(taskId) as { n: number }
    expect(count.n).toBe(1)
  })
})

// ── migrate(): backfill is guarded by hasTable on both sides ──────────────────

describe('P5.1d2: backfill guard — migrate() tolerates a missing table', () => {
  function baseSchema(d: Database.Database): void {
    d.pragma('foreign_keys = ON')
    d.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        worktree TEXT, status TEXT NOT NULL DEFAULT 'queued',
        provider TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ended_at INTEGER
      );
    `)
  }

  it('does not throw when project_tasks is absent (work_items present)', () => {
    const p = path.join(os.tmpdir(), `k-p51d2-noptt-${Date.now()}.db`)
    const d = new Database(p)
    try {
      baseSchema(d)
      d.exec(`
        CREATE TABLE work_items (
          id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, body TEXT,
          status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `)
      expect(() => migrate(d)).not.toThrow()
      // columns still added on the present table
      const cols = (d.pragma('table_info(work_items)') as Array<{ name: string }>).map(c => c.name)
      expect(cols).toContain('project_id')
    } finally {
      try { d.close() } catch { /* ignore */ }
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })

  it('does not throw when work_items is absent', () => {
    const p = path.join(os.tmpdir(), `k-p51d2-nowi-${Date.now()}.db`)
    const d = new Database(p)
    try {
      baseSchema(d)
      expect(() => migrate(d)).not.toThrow()
      const hasWorkItems = d
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'`)
        .get()
      expect(hasWorkItems).toBeUndefined()
    } finally {
      try { d.close() } catch { /* ignore */ }
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })
})

// ── live db: re-pointed projectWorkItemsDb helpers write to work_items ─────────────

describe('P5.1d2: re-pointed projectWorkItemsDb helpers hit work_items(scope=project)', () => {
  const projectId = uuid()
  const createdTaskIds: string[] = []

  afterAll(() => {
    for (const id of createdTaskIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })

  it('insertProjectTask lands in work_items and lists back via listProjectTasks', () => {
    projectsDb.insertProject.run({
      id: projectId,
      name: `p51d2-helpers-${projectId.slice(0, 8)}`,
      localPath: '/tmp/p51d2-helpers',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })

    const taskId = uuid()
    createdTaskIds.push(taskId)
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId,
      projectId,
      title: 'helper-routed task',
      status: 'open',
      createdAt: Date.now(),
      completedAt: null,
      issueNumber: null,
      issueUrl: null,
      issueState: null,
    })

    const listed = projectWorkItemsDb.listProjectTasks.all(projectId) as Array<Record<string, unknown>>
    expect(listed.some(t => t.id === taskId)).toBe(true)

    // physically stored on the unified store with the project discriminator
    const raw = db.prepare(`SELECT scope, project_id FROM work_items WHERE id = ?`).get(taskId) as
      { scope: string; project_id: string }
    expect(raw.scope).toBe('project')
    expect(raw.project_id).toBe(projectId)
  })
})

// ── kstore isolation: a null-owner run must NOT see/mutate project rows ────────
// RISK-1 guard: project rows live in work_items with run_id NULL; the run-scoped
// kstore statements add `scope != 'project'` so a null owner (unset/unknown run)
// can neither list nor mutate a project task through the personal-ticket tools.

describe('P5.1d2: kstore run-scoped views exclude project-scoped rows', () => {
  const projectId = uuid()
  const projectTaskId = uuid()

  function call(name: string, args: unknown, ctx: KStoreContext): unknown {
    const tool = kStoreTools.find(t => t.name === name)
    if (!tool) throw new Error(`no such kstore tool: ${name}`)
    return tool.handler(args, ctx)
  }

  afterAll(() => {
    db.prepare('DELETE FROM work_items WHERE project_id = ?').run(projectId)
    db.prepare(`DELETE FROM work_items WHERE run_id IS NULL AND title = 'p51d2-null-personal'`).run()
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })

  it('a null-owner work_item_list omits a project row but still sees a null-owner personal row', () => {
    projectsDb.insertProject.run({
      id: projectId, name: `p51d2-iso-${projectId.slice(0, 8)}`, localPath: '/tmp/p51d2-iso',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
    })
    // A project-scoped row (run_id NULL, scope='project') via the re-pointed helper.
    projectWorkItemsDb.insertProjectTask.run({
      id: projectTaskId, projectId, title: 'project ticket', status: 'open',
      createdAt: Date.now(), completedAt: null, issueNumber: null, issueUrl: null, issueState: null,
    })
    // A personal null-owner row via kstore (the documented shared null bucket).
    const personal = call('work_item_create', { title: 'p51d2-null-personal' }, { runId: null }) as WorkItem

    const listed = call('work_item_list', {}, { runId: null }) as WorkItem[]
    expect(listed.some(w => w.id === projectTaskId)).toBe(false) // project row hidden from kstore
    expect(listed.some(w => w.id === personal.id)).toBe(true)    // personal row still visible

    // …and the project row cannot be mutated through the personal-ticket tool.
    expect(() => call('work_item_update', { id: projectTaskId, status: 'cancelled' }, { runId: null }))
      .toThrow(KStoreError)
  })
})

// ── live db: deleteProject removes project-scoped work_items (NO-ACTION FK) ────

describe('P5.1d2: deleteProject cleans up project-scoped work_items', () => {
  it('removes the work_items rows AND the project row', () => {
    const projectId = uuid()
    projectsDb.insertProject.run({
      id: projectId,
      name: `p51d2-delete-${projectId.slice(0, 8)}`,
      localPath: '/tmp/p51d2-delete',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    const taskId = uuid()
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId,
      projectId,
      title: 'to be deleted with its project',
      status: 'open',
      createdAt: Date.now(),
      completedAt: null,
      issueNumber: null,
      issueUrl: null,
      issueState: null,
    })

    projectsDb.deleteProject(projectId)

    const count = db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?`).get(projectId) as { n: number }
    expect(count.n).toBe(0)
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId)
    expect(proj).toBeUndefined()
  })
})
