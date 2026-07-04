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
import { db, runsDb, projectsDb, migrate, SCHEMA_VERSION } from '../src/db.js'

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
    // Force the FULL scan — without this the user_version fast path would return
    // immediately and the slow-path idempotency would go untested.
    tempDb.pragma('user_version = 0')
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

// P5.4 loop-a: the Chief→lead link column. The guarded ALTER MUST match the CREATE-TABLE
// decl (ON DELETE SET NULL) — a migrated DB that dropped the on-delete action would block
// a `DELETE FROM runs` on a dispatched assignment instead of nulling the link.
describe('migrate() — mgmt_assignments.lead_run_id (guarded ALTER + FK action)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-leadrun-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds lead_run_id on an old-schema mgmt_assignments and enforces ON DELETE SET NULL', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // Old-schema (pre-P5.4): mgmt_assignments WITHOUT lead_run_id + the runs table it FKs.
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE mgmt_assignments (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        lead TEXT NOT NULL, objective TEXT NOT NULL, note TEXT, workflow TEXT,
        projects TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)

    migrate(tempDb)

    const cols = (tempDb.pragma('table_info(mgmt_assignments)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('lead_run_id')

    // Seed a run + an assignment linking to it, then delete the run: the FK's ON DELETE
    // SET NULL must null lead_run_id rather than raise a constraint error.
    const now = Date.now()
    tempDb.prepare(`INSERT INTO runs (id, prompt, cwd, created_at) VALUES ('lr-run', 'x', '.', ?)`).run(now)
    tempDb.prepare(
      `INSERT INTO mgmt_assignments (id, run_id, lead, objective, projects, lead_run_id, created_at, updated_at)
       VALUES ('lr-asg', NULL, 'Frontend', 'o', '[]', 'lr-run', ?, ?)`,
    ).run(now, now)

    expect(() => tempDb.prepare(`DELETE FROM runs WHERE id = 'lr-run'`).run()).not.toThrow()
    const asg = tempDb.prepare(`SELECT lead_run_id FROM mgmt_assignments WHERE id = 'lr-asg'`).get() as
      { lead_run_id: string | null }
    expect(asg.lead_run_id).toBeNull()
  })

  it('migrate() is idempotent for the lead_run_id branch', () => {
    // Force the FULL scan (see the runs.project_id idempotency case above).
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
  })
})

// F-074: the workflow_runs.workflow_id column (SCHEMA_VERSION 4) — the NamedWorkflow
// TEMPLATE a run was dispatched from. Guarded ALTER on a pre-F-074 workflow_runs table;
// a pre-existing row must read back workflow_id = null.
describe('migrate() — workflow_runs.workflow_id (guarded ALTER + old-schema row)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-wfid-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds workflow_id on an old-schema workflow_runs; a pre-existing row reads back null; stamps SCHEMA_VERSION', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // Old-schema (pre-F-074): workflow_runs WITHOUT workflow_id + the projects/runs it FKs.
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE workflow_runs (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
        task_ids     TEXT NOT NULL DEFAULT '[]',
        mode         TEXT NOT NULL DEFAULT 'combined',
        status       TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
        created_at   INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)

    // A pre-existing row from before the column existed.
    const now = Date.now()
    tempDb.prepare(`INSERT INTO projects (id) VALUES ('wf-proj')`).run()
    tempDb.prepare(
      `INSERT INTO workflow_runs (id, project_id, run_id, task_ids, mode, status, created_at, completed_at)
       VALUES ('wf-old', 'wf-proj', NULL, '[]', 'combined', 'running', ?, NULL)`,
    ).run(now)

    migrate(tempDb)

    // (a) the column now exists
    const cols = (tempDb.pragma('table_info(workflow_runs)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('workflow_id')

    // (b) the pre-existing row reads back workflow_id = null (backfilled NULL, not corrupted)
    const row = tempDb.prepare(`SELECT workflow_id FROM workflow_runs WHERE id = 'wf-old'`).get() as
      { workflow_id: string | null }
    expect(row.workflow_id).toBeNull()

    // (d) the schema version stamps to the current SCHEMA_VERSION (4)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('migrate() is idempotent for the workflow_id branch — second run does not error or double-add', () => {
    // Force the FULL scan (see the runs.project_id idempotency case above).
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
    // Still exactly ONE workflow_id column (no duplicate ADD COLUMN).
    const wfIdCols = (tempDb.pragma('table_info(workflow_runs)') as Array<{ name: string }>)
      .filter(c => c.name === 'workflow_id')
    expect(wfIdCols.length).toBe(1)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})

// W4 follow-up: the projects.default_branch column (SCHEMA_VERSION 5) — the repo's real
// default branch, detected + persisted at register/clone. Guarded ALTER on a pre-column
// projects table; a pre-existing row must read back default_branch = null.
describe('migrate() — projects.default_branch (guarded ALTER + old-schema row)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-defbranch-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds default_branch on an old-schema projects table; a pre-existing row reads back null; stamps SCHEMA_VERSION', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // Old-schema (pre-W4): projects WITHOUT default_branch + the runs table migrate() ALTERs.
    tempDb.exec(`
      CREATE TABLE projects (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL UNIQUE,
        local_path        TEXT NOT NULL,
        github_remote     TEXT,
        workspace_managed INTEGER NOT NULL DEFAULT 0,
        bible_dir         TEXT NOT NULL DEFAULT 'artifacts/bible',
        health_score      INTEGER,
        last_verified_at  INTEGER,
        created_at        INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
    `)

    // A pre-existing project from before the column existed.
    tempDb.prepare(
      `INSERT INTO projects (id, name, local_path, created_at) VALUES ('db-old', 'legacy', '/x', ?)`,
    ).run(Date.now())

    migrate(tempDb)

    // (a) the column now exists
    const cols = (tempDb.pragma('table_info(projects)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('default_branch')

    // (b) the pre-existing row reads back default_branch = null (backfilled NULL)
    const row = tempDb.prepare(`SELECT default_branch FROM projects WHERE id = 'db-old'`).get() as
      { default_branch: string | null }
    expect(row.default_branch).toBeNull()

    // (c) the schema version stamps to the current SCHEMA_VERSION
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('migrate() is idempotent for the default_branch branch — second run does not double-add', () => {
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
    const dbCols = (tempDb.pragma('table_info(projects)') as Array<{ name: string }>)
      .filter(c => c.name === 'default_branch')
    expect(dbCols.length).toBe(1)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})

// W7a / F-054: the k_threads.cli_session_id column (SCHEMA_VERSION 6) — the stable Claude
// CLI session id a K thread's asks resume. Guarded ALTER on a pre-column k_threads table;
// a pre-existing row must read back cli_session_id = null (the "no session yet" sentinel).
describe('migrate() — k_threads.cli_session_id (guarded ALTER + old-schema row)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-clisession-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds cli_session_id on an old-schema k_threads; a pre-existing row reads back null; stamps SCHEMA_VERSION', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // Old-schema (pre-W7a): k_threads WITHOUT cli_session_id + the runs table it FKs.
    tempDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE k_threads (
        id            TEXT PRIMARY KEY,
        title         TEXT,
        status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
        active_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `)

    // A pre-existing thread from before the column existed.
    const now = Date.now()
    tempDb.prepare(
      `INSERT INTO k_threads (id, title, status, active_run_id, created_at, updated_at)
       VALUES ('k-default', NULL, 'active', NULL, ?, ?)`,
    ).run(now, now)

    migrate(tempDb)

    // (a) the column now exists
    const cols = (tempDb.pragma('table_info(k_threads)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('cli_session_id')

    // (b) the pre-existing row reads back cli_session_id = null (backfilled NULL)
    const row = tempDb.prepare(`SELECT cli_session_id FROM k_threads WHERE id = 'k-default'`).get() as
      { cli_session_id: string | null }
    expect(row.cli_session_id).toBeNull()

    // (c) it is writable + reads back what was stamped (the resume plumbing)
    tempDb.prepare(`UPDATE k_threads SET cli_session_id = 'sess-xyz' WHERE id = 'k-default'`).run()
    expect(
      (tempDb.prepare(`SELECT cli_session_id FROM k_threads WHERE id = 'k-default'`).get() as { cli_session_id: string })
        .cli_session_id,
    ).toBe('sess-xyz')

    // (d) the schema version stamps to the current SCHEMA_VERSION
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('migrate() is idempotent for the cli_session_id branch — second run does not double-add', () => {
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
    const c = (tempDb.pragma('table_info(k_threads)') as Array<{ name: string }>)
      .filter(col => col.name === 'cli_session_id')
    expect(c.length).toBe(1)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})

describe('db migration — projects.default_branch (boot)', () => {
  it('default_branch column exists on the live db after boot migrate()', () => {
    const cols = db.pragma('table_info(projects)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('default_branch')
  })
})

describe('db migration — k_threads.cli_session_id (boot)', () => {
  it('cli_session_id column exists on the live db after boot migrate()', () => {
    const cols = db.pragma('table_info(k_threads)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('cli_session_id')
  })
})
