import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, SCHEMA_VERSION, SCHEMA_SENTINEL } from '../src/db.js'

/** Regression for the 2026-07-13 outage: a DB stamped with the CURRENT version but
 *  missing the version's columns (a "poisoned stamp" — e.g. an intermediate dev-watch
 *  boot stamped before the migration block was complete) must self-heal, not crash
 *  module-level prepares with "no such column". */
describe('poisoned schema stamp self-heal', () => {
  function oldSchemaDb(): Database.Database {
    const d = new Database(':memory:')
    // Minimal pre-v12 shapes of the tables the v12 block ALTERs.
    d.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL,
        github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
        bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', health_score INTEGER,
        last_verified_at INTEGER, created_at INTEGER NOT NULL, default_branch TEXT,
        verify_recipe TEXT, auto_merge INTEGER);
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, worktree TEXT, status TEXT,
        provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
        created_at INTEGER, ended_at INTEGER, project_id TEXT REFERENCES projects(id));
      CREATE TABLE work_items (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, body TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER, scope TEXT, project_id TEXT);
    `)
    return d
  }

  it('re-runs the full scan when the stamp is current but the sentinel column is missing', () => {
    const d = oldSchemaDb()
    d.pragma(`user_version = ${SCHEMA_VERSION}`) // the poison
    migrate(d)
    const cols = (t: string) => (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
    expect(cols('projects')).toContain('budget_daily_usd')
    expect(cols('work_items')).toContain('source_key')
    expect(cols('runs')).toContain('retry_of')
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })

  it('fast-path still skips when stamp AND sentinel agree', () => {
    const d = oldSchemaDb()
    d.pragma('user_version = 0')
    migrate(d) // full scan, stamps + adds sentinel
    // Second call must take the fast path (no throw, no work needed — smoke of the gate).
    expect(() => migrate(d)).not.toThrow()
    d.close()
  })

  it('SCHEMA_SENTINEL names a column the current migrateSlow actually creates', () => {
    const d = oldSchemaDb()
    d.pragma('user_version = 0')
    migrate(d)
    const cols = (d.pragma(`table_info(${SCHEMA_SENTINEL.table})`) as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain(SCHEMA_SENTINEL.column)
    d.close()
  })
})
