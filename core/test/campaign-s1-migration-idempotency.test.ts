/**
 * Campaign S1 — migrate() idempotency & cross-connection behavior
 * (LOCK / characterization). Extends db-migration.test.ts (old-schema ALTER) and
 * events-unique.test.ts (dedup + unique index) — does not duplicate them.
 *
 *  - migrate() is idempotent on the live, fully-migrated production schema: a
 *    re-run throws nothing and the columns/indexes remain (S1-019).
 *  - migrate() assumes the base tables already exist (db.ts runs the CREATE TABLE
 *    DDL before migrate()): against an empty DB the runs ALTER throws
 *    "no such table" — a documented ordering contract (S1-020).
 *  - Two connections each running migrate() against the same old-schema file both
 *    succeed: the hasColumn guard sees the other connection's COMMITTED column and
 *    skips, so the realistic cross-connection case never hits "duplicate column"
 *    (S1-021).
 *  - Supporting characterization for FAULT S1-018: the inline runs.project_id /
 *    verification_reports.score_breakdown ALTERs are guarded ONLY by a hasColumn
 *    TOCTOU check, NOT by the duplicate-column-tolerant try/catch that addColumn()
 *    uses. The raw statement migrate() executes is shown here to be non-tolerant,
 *    while an addColumn-style guard swallows the duplicate. The CONFIRMED concurrent
 *    crash this enables is codified (RED) at
 *    core/test/regressions/s1-018-concurrent-migrate-duplicate-column.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, migrate } from '../src/db.js'

const tmpFiles: string[] = []
function tmpDb(): { db: Database.Database; path: string } {
  const p = path.join(os.tmpdir(), `k-s1-mig-${process.pid}-${tmpFiles.length}-${Date.now()}.db`)
  tmpFiles.push(p)
  return { db: new Database(p), path: p }
}

const OLD_RUNS_DDL = `
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
  );
`

// Old-schema shape for every table migrate() touches (pre-ALTER columns absent,
// no events unique index) — exercises all migration branches.
const OLD_FULL_DDL = `
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
    ts INTEGER NOT NULL, raw TEXT, text TEXT, tool TEXT,
    tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL
  );
  CREATE TABLE verification_reports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, score INTEGER NOT NULL,
    findings TEXT NOT NULL DEFAULT '[]', fixes_applied TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE TABLE project_tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, completed_at INTEGER
  );
`

afterAll(() => {
  for (const p of tmpFiles) for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + ext) } catch { /* ignore */ }
  }
})

describe('S1 — migrate() idempotency across all branches', () => {
  it('a second migrate() on a fully-migrated DB throws nothing and is a no-op', () => {
    const { db: c } = tmpDb()
    c.exec(OLD_FULL_DDL)
    expect(() => migrate(c)).not.toThrow() // first pass: adds columns/indexes, dedup
    // Force the FULL scan on the second pass — the user_version fast path would
    // otherwise no-op trivially; the per-branch idempotency is what's under test.
    c.pragma('user_version = 0')
    expect(() => migrate(c)).not.toThrow() // second pass: idempotent no-op

    const cols = (t: string) => (c.pragma(`table_info(${t})`) as Array<{ name: string }>).map(x => x.name)
    const idx = (t: string) => (c.pragma(`index_list(${t})`) as Array<{ name: string }>).map(x => x.name)
    expect(cols('runs')).toContain('project_id')
    expect(idx('runs')).toEqual(expect.arrayContaining(['idx_runs_project', 'idx_runs_created_at']))
    expect(cols('events')).toEqual(expect.arrayContaining(['tool_use_id', 'context_tokens']))
    expect(idx('events')).toContain('idx_events_run_seq')
    expect(cols('verification_reports')).toContain('score_breakdown')
    expect(cols('project_tasks')).toContain('issue_number')
    c.close()
  })

  it('the live production schema already carries the events unique index (read-only)', () => {
    // Read-only pragma on the shared connection — no write, no lock contention.
    const evIdx = (db.pragma('index_list(events)') as Array<{ name: string }>).map(i => i.name)
    expect(evIdx).toContain('idx_events_run_seq')
  })
})

describe('S1 — migrate() requires the base tables (DDL-before-migrate contract)', () => {
  it('against an empty DB the runs ALTER throws "no such table"', () => {
    const { db: empty } = tmpDb()
    expect(() => migrate(empty)).toThrow(/no such table/i)
    empty.close()
  })
})

describe('S1 — two connections migrating the same old-schema file', () => {
  it('both succeed: the committed cross-connection column is seen and skipped', () => {
    const { db: c1, path: p } = tmpDb()
    c1.exec(OLD_RUNS_DDL)
    const c2 = new Database(p)
    try {
      expect(() => migrate(c1)).not.toThrow()
      // Reset the (file-level) user_version c1 just stamped so c2 takes the FULL
      // scan — the hasColumn skip, not the version fast path, is what's under test.
      c2.pragma('user_version = 0')
      expect(() => migrate(c2)).not.toThrow() // sees c1's committed project_id, skips
      const cols = (c2.pragma('table_info(runs)') as Array<{ name: string }>).map(c => c.name)
      expect(cols.filter(n => n === 'project_id')).toHaveLength(1) // added exactly once
    } finally {
      c1.close(); c2.close()
    }
  })
})

describe('S1 — inline ALTER is not duplicate-tolerant (supports FAULT S1-018)', () => {
  it('the raw ALTER migrate() runs throws on a pre-added column; an addColumn-style guard would not', () => {
    const { db: conn, path: p } = tmpDb()
    conn.exec(OLD_RUNS_DDL)
    const other = new Database(p)
    // Simulate "the other process won the race" and already committed the column.
    other.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id)`)

    // The exact statement migrate() executes for runs.project_id (no try/catch):
    expect(() =>
      conn.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id)`),
    ).toThrow(/duplicate column name/i)

    // Contrast: the addColumn() helper's pattern swallows the same error.
    const tolerantAddColumn = () => {
      try {
        conn.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id)`)
      } catch (e) {
        if (!/duplicate column name/i.test(String(e))) throw e
      }
    }
    expect(tolerantAddColumn).not.toThrow()

    conn.close(); other.close()
  })
})
