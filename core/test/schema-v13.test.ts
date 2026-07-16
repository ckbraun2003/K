// core/test/schema-v13.test.ts — Impressive Wave v13 migration + the SCHEMA_SENTINEL
// newest-column contract (deh ledger follow-up: a poison missing ONLY the newest
// version's columns must not evade the sentinel).
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { db, migrate, SCHEMA_VERSION, SCHEMA_SENTINEL } from '../src/db.js'

function cols(d: Database.Database, t: string): string[] {
  return (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
}

/** A v12-COMPLETE scratch DB: every pre-v13 table/column the v13 block touches,
 *  INCLUDING the full v12 column set (budget_daily_usd, source_key, retry_of…) so a
 *  sentinel still pointing at a v12 column would be evaded by this shape. Extend this
 *  fixture with the previous generation's columns at EVERY future SCHEMA_VERSION bump —
 *  that maintenance step IS the newest-column enforcement. */
function v12CompleteDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL,
      github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
      bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', health_score INTEGER,
      last_verified_at INTEGER, created_at INTEGER NOT NULL, default_branch TEXT,
      verify_recipe TEXT, auto_merge INTEGER, budget_daily_usd REAL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, worktree TEXT, status TEXT,
      provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      created_at INTEGER, ended_at INTEGER, project_id TEXT REFERENCES projects(id),
      retry_of TEXT, retry_count INTEGER NOT NULL DEFAULT 0, failure_class TEXT);
    CREATE TABLE work_items (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, body TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, scope TEXT, project_id TEXT,
      source TEXT, source_key TEXT);
    CREATE TABLE artifacts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, phase TEXT, status TEXT,
      tags TEXT NOT NULL DEFAULT '[]', linked_run_id TEXT, updated_at INTEGER NOT NULL,
      md TEXT NOT NULL, html_path TEXT);
    CREATE TABLE eval_results (id TEXT PRIMARY KEY, evalRunId TEXT NOT NULL, systemId TEXT NOT NULL,
      caseId TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, detPass INTEGER,
      detScore REAL, formatScore REAL, judgeOverall REAL, judgeVerdict TEXT, refusalCorrect INTEGER,
      costUsd REAL, ms INTEGER, numTurns INTEGER, error TEXT, raw TEXT, createdAt INTEGER NOT NULL);
  `)
  return d
}

describe('schema v13', () => {
  // v13 columns must persist across later bumps; the exact-version + sentinel pin now
  // lives in schema-v14.test.ts (moved there when v14 relocated SCHEMA_SENTINEL to
  // runs.pipeline_stage_id). Mirrors how schema-v12.test.ts relaxed its own pin at v13.
  it('is version 13 or later', () => { expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(13) })

  it('adds the three v13 columns on the live test DB', () => {
    expect(cols(db as unknown as Database.Database, 'artifacts'))
      .toEqual(expect.arrayContaining(['project_id', 'origin']))
    expect(cols(db as unknown as Database.Database, 'eval_results'))
      .toEqual(expect.arrayContaining(['failure_reason']))
  })

  it('backfills artifacts.project_id from project-<id>-… slug prefixes (existing projects only)', () => {
    const d = v12CompleteDb()
    d.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
      .run('11111111-2222-3333-4444-555555555555', 'p1', 'C:/tmp/p1', 1)
    const ins = d.prepare(`INSERT INTO artifacts (slug, title, updated_at, md) VALUES (?, ?, 1, '')`)
    ins.run('project-11111111-2222-3333-4444-555555555555-bible', 'p1 bible')
    ins.run('project-99999999-0000-0000-0000-000000000000-bible', 'orphan bible') // project gone
    ins.run('project-bible', 'harness bible')
    ins.run('ui-demo', 'demo')
    migrate(d)
    const pid = (s: string) => (d.prepare(`SELECT project_id FROM artifacts WHERE slug = ?`).get(s) as { project_id: string | null }).project_id
    expect(pid('project-11111111-2222-3333-4444-555555555555-bible')).toBe('11111111-2222-3333-4444-555555555555')
    expect(pid('project-99999999-0000-0000-0000-000000000000-bible')).toBeNull() // FK-safe: no stamp for a deleted project
    expect(pid('project-bible')).toBeNull()
    expect(pid('ui-demo')).toBeNull()
    // every pre-v13 row is compiled-origin
    expect((d.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE origin != 'compiled'`).get() as { n: number }).n).toBe(0)
    d.close()
  })

  it('back-compat: a v12-complete DB poison-stamped at the current version self-heals', () => {
    const d = v12CompleteDb()
    // The precise newest-column sentinel contract lives in schema-v14.test.ts. Here we
    // prove a TWO-generations-old (v12-complete) DB, poison-stamped at the current
    // version, still re-runs the full scan and heals to current: the fixture holds the
    // v12 columns but NOT the current sentinel (runs.pipeline_stage_id), so it's caught.
    expect(cols(d, 'projects')).toContain('budget_daily_usd')
    expect(cols(d, SCHEMA_SENTINEL.table)).not.toContain(SCHEMA_SENTINEL.column)
    d.pragma(`user_version = ${SCHEMA_VERSION}`) // the poison
    migrate(d)
    expect(cols(d, 'artifacts')).toEqual(expect.arrayContaining(['project_id', 'origin']))
    expect(cols(d, 'eval_results')).toContain('failure_reason')
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })
})
