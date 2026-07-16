// core/test/schema-v14.test.ts — Pipeline Engine (D-119) v13→v14 migration + the
// SCHEMA_SENTINEL newest-column contract. A poison missing ONLY the newest version's
// columns must not evade the sentinel — which is why the fixture is v13-COMPLETE.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { db, migrate, SCHEMA_VERSION, SCHEMA_SENTINEL } from '../src/db.js'

function cols(d: Database.Database, t: string): string[] {
  return (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
}
function hasTable(d: Database.Database, t: string): boolean {
  return !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
}

/** A v13-COMPLETE scratch DB: every pre-v14 table/column the v14 block touches,
 *  INCLUDING the full v13 column set (artifacts.origin/project_id, eval_results.
 *  failure_reason) so a sentinel still pointing at a v13 column would be evaded by this
 *  shape. The `runs` table lacks pipeline_stage_id and `workflow_definitions` lacks
 *  `spec` — the two v14 additions. Extend this fixture with the previous generation's
 *  columns at EVERY future SCHEMA_VERSION bump — that maintenance step IS the
 *  newest-column enforcement. */
function v13CompleteDb(): Database.Database {
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
      md TEXT NOT NULL, html_path TEXT, project_id TEXT,
      origin TEXT NOT NULL DEFAULT 'compiled' CHECK(origin IN ('compiled','scanned')));
    CREATE TABLE eval_results (id TEXT PRIMARY KEY, evalRunId TEXT NOT NULL, systemId TEXT NOT NULL,
      caseId TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, detPass INTEGER,
      detScore REAL, formatScore REAL, judgeOverall REAL, judgeVerdict TEXT, refusalCorrect INTEGER,
      costUsd REAL, ms INTEGER, numTurns INTEGER, error TEXT, raw TEXT, createdAt INTEGER NOT NULL,
      failure_reason TEXT);
    CREATE TABLE workflow_definitions (id TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL,
      prompt_scaffold TEXT NOT NULL, cross_project INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `)
  return d
}

describe('schema v14', () => {
  it('is version 14 and the sentinel is a v14 column', () => {
    expect(SCHEMA_VERSION).toBe(14)
    expect(SCHEMA_SENTINEL).toEqual({ table: 'runs', column: 'pipeline_stage_id' })
  })

  it('adds the two v14 columns and the five pipeline tables on the live test DB', () => {
    const live = db as unknown as Database.Database
    expect(cols(live, 'runs')).toContain('pipeline_stage_id')
    expect(cols(live, 'workflow_definitions')).toContain('spec')
    for (const t of ['pipeline_runs', 'pipeline_stages', 'pipeline_edges', 'pipeline_dispatches', 'hook_definitions']) {
      expect(hasTable(live, t)).toBe(true)
    }
    // spot-check the columns the pipelineDb prepared statements bind against
    expect(cols(live, 'pipeline_stages'))
      .toEqual(expect.arrayContaining(['stage_key', 'run_id', 'result_commit', 'gate_note', 'repairs_used']))
    expect(cols(live, 'pipeline_runs'))
      .toEqual(expect.arrayContaining(['base_commit', 'cwd', 'status']))
    expect(cols(live, 'hook_definitions'))
      .toEqual(expect.arrayContaining(['event', 'matcher', 'source', 'trusted', 'enabled']))
  })

  it('NEWEST-COLUMN sentinel: a v13-complete DB stamped 14 (missing only v14 columns) self-heals', () => {
    const d = v13CompleteDb()
    // Guard the guard: this fixture MUST already hold the OLD (v13) sentinel column — if
    // SCHEMA_SENTINEL still named artifacts.origin, this poison would evade it.
    expect(cols(d, 'artifacts')).toContain('origin')
    expect(cols(d, SCHEMA_SENTINEL.table)).not.toContain(SCHEMA_SENTINEL.column) // runs lacks pipeline_stage_id
    expect(cols(d, 'workflow_definitions')).not.toContain('spec')
    d.pragma(`user_version = ${SCHEMA_VERSION}`) // the poison
    migrate(d)
    expect(cols(d, 'runs')).toContain('pipeline_stage_id')
    expect(cols(d, 'workflow_definitions')).toContain('spec')
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })
})
