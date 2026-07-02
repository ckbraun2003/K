/**
 * A2 — P5.1d2b: complete the project_tasks → work_items collapse.
 *
 * d2a left `project_tasks` behind as a frozen safety copy with a RECURRING
 * boot-time backfill, while deleteProjectTask removes only the work_items row —
 * so any pre-d2a task deleted via the API RESURRECTED from the frozen copy on
 * the next boot. d2b makes the backfill a ONE-SHOT flag-guarded migration that
 * runs one last time and then DROPS project_tasks for good.
 *
 * Fixtures mirror p5-1d2-collapse.test.ts: old-schema tempDbs (better-sqlite3,
 * os.tmpdir) exercise migrate() in isolation; live-db sections clean up their
 * rows in afterAll.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { IssueInfo, Project } from '@k/shared'
import { db, projectsDb, projectWorkItemsDb, migrate } from '../src/db.js'
import { syncIssues } from '../src/github.js'

// Old-schema DB (pre-d2a shape): projects+runs (migrate()'s unconditional runs
// ALTER needs them), a PRE-collapse work_items (no scope / no project cols) and
// a project_tasks table carrying the full issue-sync metadata.
const OLD_SCHEMA = `
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
`

// ── the resurrection bug (RED on d2a code) ─────────────────────────────────────

describe('P5.1d2b: a deleted project task must NOT resurrect on re-boot', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a2-d2b-resurrect-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('delete → re-migrate → the row stays gone; project_tasks dropped; one-shot flag set', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    tempDb.exec(OLD_SCHEMA)

    const projectId = uuid()
    const taskId = uuid()
    tempDb.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
    tempDb
      .prepare(`INSERT INTO project_tasks
        (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
        VALUES (?, ?, 'pre-d2a task', 'open', 1000, NULL, NULL, NULL, NULL)`)
      .run(taskId, projectId)

    // Boot 1: the collapse migration lands the row in work_items.
    migrate(tempDb)
    const landed = tempDb.prepare(`SELECT * FROM work_items WHERE id = ?`).get(taskId)
    expect(landed).toBeTruthy()

    // The operator deletes the task via the API — deleteProjectTask removes ONLY
    // the work_items row (project_tasks was left behind as a frozen copy in d2a).
    tempDb.prepare(`DELETE FROM work_items WHERE id = ?`).run(taskId)

    // Boot 2: the delete must be durable. RED on d2a code — the recurring
    // backfill re-inserts the row from the frozen project_tasks copy.
    migrate(tempDb)
    const resurrected = tempDb.prepare(`SELECT * FROM work_items WHERE id = ?`).get(taskId)
    expect(resurrected).toBeUndefined()

    // d2b end-state: the table is gone for good and the one-shot flag is set.
    const table = tempDb
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_tasks'`)
      .get()
    expect(table).toBeUndefined()
    const flag = tempDb
      .prepare(`SELECT value FROM app_config WHERE key = 'mig_project_tasks_drop'`)
      .get()
    expect(flag).toBeTruthy()
  })
})

// ── one-shot / no-op paths ─────────────────────────────────────────────────────

describe('P5.1d2b: drop migration one-shot / no-op paths', () => {
  const tmpPaths: string[] = []
  function tempDbAt(tag: string): Database.Database {
    const p = path.join(os.tmpdir(), `k-a2-d2b-${tag}-${Date.now()}-${tmpPaths.length}.db`)
    tmpPaths.push(p)
    const d = new Database(p)
    d.pragma('foreign_keys = ON')
    return d
  }

  afterAll(() => {
    for (const p of tmpPaths) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })

  it('(a) a DB where project_tasks never existed: migrate() no-throw, no table created', () => {
    const d = tempDbAt('never')
    try {
      // OLD_SCHEMA minus project_tasks
      d.exec(OLD_SCHEMA.replace(/CREATE TABLE project_tasks[\s\S]*?\);/, ''))
      expect(() => migrate(d)).not.toThrow()
      expect(
        d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_tasks'`).get(),
      ).toBeUndefined()
    } finally {
      d.close()
    }
  })

  it('(b) a DB where the drop already ran: second migrate() is a no-op, no-throw', () => {
    const d = tempDbAt('done')
    try {
      d.exec(OLD_SCHEMA)
      const projectId = uuid()
      const taskId = uuid()
      d.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
      d.prepare(`INSERT INTO project_tasks (id, project_id, title, status, created_at)
                 VALUES (?, ?, 't', 'open', 1)`).run(taskId, projectId)
      migrate(d) // backfill + drop + flag
      expect(() => migrate(d)).not.toThrow() // no-op: flag set, table gone
      expect(
        d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_tasks'`).get(),
      ).toBeUndefined()
      expect(
        d.prepare(`SELECT value FROM app_config WHERE key = 'mig_project_tasks_drop'`).get(),
      ).toBeTruthy()
      // the backfilled row is still there, exactly once
      const n = d.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE id = ?`).get(taskId) as { n: number }
      expect(n.n).toBe(1)
    } finally {
      d.close()
    }
  })

  it('(c) an old DB WITH rows: all rows land in work_items with metadata intact, table gone', () => {
    const d = tempDbAt('rows')
    try {
      d.exec(OLD_SCHEMA)
      const projectId = uuid()
      const doneId = uuid()
      const openId = uuid()
      d.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
      d.prepare(`INSERT INTO project_tasks
          (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
          VALUES (?, ?, 'done task', 'done', 1000, 2000, 42, 'https://gh/issues/42', 'CLOSED')`)
        .run(doneId, projectId)
      d.prepare(`INSERT INTO project_tasks
          (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
          VALUES (?, ?, 'open task', 'open', 3000, NULL, NULL, NULL, NULL)`)
        .run(openId, projectId)

      migrate(d)

      const done = d.prepare(`SELECT * FROM work_items WHERE id = ?`).get(doneId) as Record<string, unknown>
      expect(done).toBeTruthy()
      expect(done.scope).toBe('project')
      expect(done.project_id).toBe(projectId)
      expect(done.title).toBe('done task')
      expect(done.status).toBe('done')
      expect(done.created_at).toBe(1000)
      expect(done.updated_at).toBe(1000) // reuses created_at (old store had none)
      expect(done.completed_at).toBe(2000)
      expect(done.issue_number).toBe(42)
      expect(done.issue_url).toBe('https://gh/issues/42')
      expect(done.issue_state).toBe('CLOSED')
      expect(done.run_id).toBeNull()

      const open = d.prepare(`SELECT * FROM work_items WHERE id = ?`).get(openId) as Record<string, unknown>
      expect(open).toBeTruthy()
      expect(open.status).toBe('open')
      expect(open.completed_at).toBeNull()
      expect(open.issue_number).toBeNull()

      expect(
        d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_tasks'`).get(),
      ).toBeUndefined()
    } finally {
      d.close()
    }
  })
})

// ── live db: updateProjectTaskFromIssue binds project_id (cross-project defense) ──

describe('P5.1d2b: updateProjectTaskFromIssue is project-bound', () => {
  const projectA = uuid()
  const projectB = uuid()
  const taskId = uuid()

  afterAll(() => {
    db.prepare('DELETE FROM work_items WHERE project_id IN (?, ?)').run(projectA, projectB)
    db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(projectA, projectB)
  })

  it('a foreign projectId updates nothing; the owning projectId updates the row', () => {
    for (const [id, tag] of [[projectA, 'a'], [projectB, 'b']] as const) {
      projectsDb.insertProject.run({
        id, name: `a2-bind-${tag}-${id.slice(0, 8)}`, localPath: os.tmpdir(),
        githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
      })
    }
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId, projectId: projectA, title: 'original', status: 'open',
      createdAt: Date.now(), completedAt: null, issueNumber: 5, issueUrl: 'u', issueState: 'OPEN',
    })

    // A's task id + B's projectId → no row matches, nothing changes.
    const miss = projectWorkItemsDb.updateProjectTaskFromIssue.run({
      id: taskId, projectId: projectB, title: 'hijacked', issueUrl: 'u2', issueState: 'OPEN',
      status: 'open', completedAt: null,
    })
    expect(miss.changes).toBe(0)
    const unchanged = projectWorkItemsDb.getProjectTask.get(taskId, projectA) as Record<string, unknown>
    expect(unchanged.title).toBe('original')
    expect(unchanged.issue_url).toBe('u')

    // the owning projectId → the row updates.
    const hit = projectWorkItemsDb.updateProjectTaskFromIssue.run({
      id: taskId, projectId: projectA, title: 'refreshed', issueUrl: 'u3', issueState: 'OPEN',
      status: 'open', completedAt: null,
    })
    expect(hit.changes).toBe(1)
    const updated = projectWorkItemsDb.getProjectTask.get(taskId, projectA) as Record<string, unknown>
    expect(updated.title).toBe('refreshed')
    expect(updated.issue_url).toBe('u3')
  })
})

// ── migrate(): (project_id, issue_number) dedupe + partial unique index ─────────

describe('P5.1d2b: issue-mirror dedupe + idx_work_items_project_issue', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a2-d2b-dedupe-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('dedupes to the newest created_at, creates the unique index, and the index enforces', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // POST-d2a shape: work_items already carries scope (CURRENT enum incl. 'run')
    // + the project/issue columns — the work_items_new DDL from the A1 rebuild —
    // plus the NON-unique idx_work_items_issue. No project_tasks.
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
        run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        status      TEXT NOT NULL DEFAULT 'open'
                      CHECK(status IN ('open','in_progress','blocked','done','cancelled')),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'run'
                      CHECK(scope IN ('run','personal','org','project')),
        project_id   TEXT REFERENCES projects(id),
        completed_at INTEGER,
        issue_number INTEGER,
        issue_url    TEXT,
        issue_state  TEXT
      );
      CREATE INDEX idx_work_items_issue ON work_items(project_id, issue_number);
    `)

    const projectId = uuid()
    const otherProject = uuid()
    const oldRow = uuid()
    const newRow = uuid()
    tempDb.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
    tempDb.prepare(`INSERT INTO projects (id) VALUES (?)`).run(otherProject)
    const seed = tempDb.prepare(`
      INSERT INTO work_items (id, run_id, project_id, title, status, scope, created_at, updated_at, issue_number)
      VALUES (@id, NULL, @projectId, @title, 'open', 'project', @createdAt, @createdAt, @issueNumber)
    `)
    // the double-mirror: same (project, issue#) twice
    seed.run({ id: oldRow, projectId, title: 'stale mirror', createdAt: 1000, issueNumber: 7 })
    seed.run({ id: newRow, projectId, title: 'fresh mirror', createdAt: 2000, issueNumber: 7 })

    migrate(tempDb)

    // survivor = newest created_at
    expect(tempDb.prepare(`SELECT id FROM work_items WHERE id = ?`).get(oldRow)).toBeUndefined()
    expect(tempDb.prepare(`SELECT id FROM work_items WHERE id = ?`).get(newRow)).toBeTruthy()
    expect(
      tempDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_work_items_project_issue'`).get(),
    ).toBeTruthy()

    // the unique index enforces: same (project, 7) again throws…
    expect(() =>
      seed.run({ id: uuid(), projectId, title: 'dup', createdAt: 3000, issueNumber: 7 }),
    ).toThrow(/UNIQUE/)
    // …while NULL issue_numbers are exempt (partial index)…
    expect(() => {
      seed.run({ id: uuid(), projectId, title: 'no issue 1', createdAt: 3000, issueNumber: null })
      seed.run({ id: uuid(), projectId, title: 'no issue 2', createdAt: 3000, issueNumber: null })
    }).not.toThrow()
    // …and the same issue# in a DIFFERENT project is fine.
    expect(() =>
      seed.run({ id: uuid(), projectId: otherProject, title: 'other project', createdAt: 3000, issueNumber: 7 }),
    ).not.toThrow()
  })
})

// ── live db: syncIssues cannot double-mirror one issue ──────────────────────────

describe('P5.1d2b: syncIssues syncs the same issue twice into ONE row', () => {
  const projectId = uuid()
  const project: Project = {
    id: projectId,
    name: `a2-sync-${projectId.slice(0, 8)}`,
    localPath: os.tmpdir(),
    githubRemote: 'owner/repo',
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }

  afterAll(() => {
    db.prepare('DELETE FROM work_items WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })

  it('second sync takes the update path — exactly one row, title refreshed', async () => {
    projectsDb.insertProject.run({
      id: projectId, name: project.name, localPath: project.localPath,
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
    })
    const issue = (title: string): IssueInfo[] =>
      [{ number: 21, title, state: 'OPEN', url: 'https://gh/issues/21' }]

    const first = await syncIssues(project, async () => issue('first title'))
    expect(first).toEqual({ synced: 1, degraded: false })
    const second = await syncIssues(project, async () => issue('second title'))
    expect(second).toEqual({ synced: 1, degraded: false })

    const rows = db
      .prepare(`SELECT * FROM work_items WHERE project_id = ? AND issue_number = 21 AND scope = 'project'`)
      .all(projectId) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)          // no double mirror
    expect(rows[0].title).toBe('second title') // update path, not a second insert
  })
})

// ── compound legacy vintage: d2a columns + pre-A1 CHECK + stale frozen dup ─────
// The #1-risk upgrade path, pinned as a CI tripwire against any reorder of the
// three migration blocks (d2b backfill+drop → A1 run-scope rebuild → dedupe +
// unique index). ONE migrate() call must take a d2a-shipped DB (project/issue
// columns present, scope CHECK still the pre-A1 ('personal','org','project')
// enum) whose frozen project_tasks copy holds a STALE duplicate of a live
// (project_id, issue_number) mirror, and land it in the final state: backfill
// fires (introducing the dup), the rebuild consumes the backfilled data and
// re-stamps legacy rows, and the dedupe+index runs LAST so the dup is gone and
// the unique index exists. A reorder (e.g. index before rebuild, or dedupe
// before backfill) breaks at least one assertion below.

describe('P5.1d2b: compound vintage — pre-A1 CHECK + d2a columns + stale frozen duplicate, one migrate()', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a2-d2b-compound-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('drop + flag + personal→run re-stamp + dedupe survivor + partial unique index + clean FKs', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // The d2a-shipped vintage: work_items carries the project/issue columns and
    // the three non-unique indexes, but still the PRE-A1 scope CHECK (DEFAULT
    // 'personal', no 'run' — copied from a1-work-items-migration.test.ts); the
    // frozen project_tasks copy (with issue columns) is still present.
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
        run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        status      TEXT NOT NULL DEFAULT 'open'
                      CHECK(status IN ('open','in_progress','blocked','done','cancelled')),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','org','project')),
        project_id   TEXT REFERENCES projects(id),
        completed_at INTEGER,
        issue_number INTEGER,
        issue_url    TEXT,
        issue_state  TEXT
      );
      CREATE INDEX idx_work_items_run ON work_items(run_id, created_at);
      CREATE INDEX idx_work_items_project ON work_items(project_id, created_at);
      CREATE INDEX idx_work_items_issue ON work_items(project_id, issue_number);
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
    const runId = uuid()
    const legacyPersonalId = uuid()
    const liveMirrorId = uuid()   // the newer live mirror of issue #7
    const staleFrozenId = uuid()  // the stale frozen dup of the SAME (project, #7)
    tempDb.prepare(`INSERT INTO projects (id) VALUES (?)`).run(projectId)
    tempDb.prepare(`INSERT INTO runs (id, prompt, cwd, created_at) VALUES (?, 'x', '.', 1)`).run(runId)
    tempDb.prepare(`
      INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
      VALUES (?, ?, 'legacy kstore ticket', 'open', 1, 1, 'personal')
    `).run(legacyPersonalId, runId)
    tempDb.prepare(`
      INSERT INTO work_items (id, run_id, project_id, title, status, scope, created_at, updated_at, issue_number, issue_url, issue_state)
      VALUES (?, NULL, ?, 'live mirror', 'open', 'project', 2000, 2000, 7, 'https://gh/issues/7', 'OPEN')
    `).run(liveMirrorId, projectId)
    tempDb.prepare(`
      INSERT INTO project_tasks (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
      VALUES (?, ?, 'stale frozen mirror', 'open', 1000, NULL, 7, 'https://gh/issues/7', 'OPEN')
    `).run(staleFrozenId, projectId)

    expect(() => migrate(tempDb)).not.toThrow()

    // project_tasks gone + one-shot flag set
    expect(
      tempDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_tasks'`).get(),
    ).toBeUndefined()
    expect(
      tempDb.prepare(`SELECT value FROM app_config WHERE key = 'mig_project_tasks_drop'`).get(),
    ).toBeTruthy()

    // A1's rebuild consumed the backfilled data fine: legacy 'personal' → 'run'
    const legacy = tempDb.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(legacyPersonalId) as { scope: string }
    expect(legacy.scope).toBe('run')

    // idx_work_items_project_issue exists, UNIQUE and partial
    const idx = (tempDb.pragma('index_list(work_items)') as Array<{ name: string; unique: number; partial: number }>)
      .find(i => i.name === 'idx_work_items_project_issue')
    expect(idx).toBeTruthy()
    expect(idx!.unique).toBe(1)
    expect(idx!.partial).toBe(1)

    // only the NEWER duplicate survived (the backfilled stale frozen row was deduped)
    expect(tempDb.prepare(`SELECT 1 FROM work_items WHERE id = ?`).get(staleFrozenId)).toBeUndefined()
    expect(tempDb.prepare(`SELECT 1 FROM work_items WHERE id = ?`).get(liveMirrorId)).toBeTruthy()
    const mirrors = tempDb
      .prepare(`SELECT COUNT(*) AS n FROM work_items WHERE project_id = ? AND issue_number = 7 AND scope = 'project'`)
      .get(projectId) as { n: number }
    expect(mirrors.n).toBe(1)

    // no dangling references anywhere after backfill + rebuild + dedupe + drop
    expect(tempDb.pragma('foreign_key_check')).toEqual([])
  })
})
