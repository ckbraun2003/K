// core/test/schema-v15.test.ts — Orchestration Program Phase 2 W0 (D-120) v14→v15
// migration + the SCHEMA_SENTINEL newest-column contract. A poison missing ONLY the
// newest version's columns must not evade the sentinel — which is why the fixture is
// v14-COMPLETE.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { db, migrate, SCHEMA_VERSION, SCHEMA_SENTINEL } from '../src/db.js'

function cols(d: Database.Database, t: string): string[] {
  return (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
}
function hasTable(d: Database.Database, t: string): boolean {
  return !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
}

/** A v14-COMPLETE scratch DB: every pre-v15 table/column the v15 block touches,
 *  INCLUDING the full v14 column set (runs.pipeline_stage_id, workflow_definitions.spec,
 *  the pipeline_runs/pipeline_stages/pipeline_edges shapes) so a sentinel still pointing
 *  at a v14 column would be evaded by this shape. skills carries the full D-069 catalog
 *  shape (matching the fresh-install DDL exactly — NOT the old `name … UNIQUE` shape) so
 *  migrate()'s unrelated skills-rebuild step is a guaranteed no-op against it. Extend this
 *  fixture with the previous generation's columns at EVERY future SCHEMA_VERSION bump —
 *  that maintenance step IS the newest-column enforcement. */
function v14CompleteDb(): Database.Database {
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
      retry_of TEXT, retry_count INTEGER NOT NULL DEFAULT 0, failure_class TEXT,
      pipeline_stage_id TEXT);
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
      prompt_scaffold TEXT NOT NULL, cross_project INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      spec TEXT);
    CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, definition_id TEXT,
      project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, cwd TEXT NOT NULL,
      base_commit TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE pipeline_stages (id TEXT PRIMARY KEY, pipeline_run_id TEXT NOT NULL,
      stage_key TEXT NOT NULL, kind TEXT NOT NULL, profile_id TEXT, spec TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', run_id TEXT, base_commit TEXT, result_commit TEXT,
      exit_code INTEGER, failure_class TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      repair_stage_key TEXT, repairs_used INTEGER NOT NULL DEFAULT 0, gate_resolved_by TEXT,
      gate_note TEXT, cost_usd REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, completed_at INTEGER);
    CREATE TABLE pipeline_edges (id TEXT PRIMARY KEY, pipeline_run_id TEXT NOT NULL,
      from_stage_key TEXT, to_stage_key TEXT NOT NULL, handoff TEXT NOT NULL,
      when_cond TEXT NOT NULL DEFAULT 'always');
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      type TEXT NOT NULL CHECK(type IN ('skill','hook','workflow')), source TEXT NOT NULL,
      triggerType TEXT NOT NULL CHECK(triggerType IN ('manual','schedule','event')),
      schedule TEXT, eventTrigger TEXT, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'k', origin_path TEXT, project_id TEXT, plugin_id TEXT,
      plugin_version TEXT, content_hash TEXT, est_tokens INTEGER, est_tokens_meta INTEGER,
      status TEXT NOT NULL DEFAULT 'ok', last_scanned_at INTEGER, qualified_key TEXT NOT NULL UNIQUE);
  `)
  return d
}

describe('schema v15', () => {
  it('is version 15 and the sentinel is a v15 column', () => {
    expect(SCHEMA_VERSION).toBe(15)
    expect(SCHEMA_SENTINEL).toEqual({ table: 'pipeline_ledger', column: 'seq' })
  })

  it('adds the two v15 tables and the four v15 columns on the live test DB', () => {
    const live = db as unknown as Database.Database
    for (const t of ['sub_agent_defs', 'pipeline_ledger']) {
      expect(hasTable(live, t)).toBe(true)
    }
    // spot-check the columns the subAgentDb / pipelineLedgerDb prepared statements bind against
    expect(cols(live, 'sub_agent_defs')).toEqual(expect.arrayContaining(
      ['id', 'name', 'role', 'model', 'allowed_tools', 'mcp_servers', 'skills', 'prompt', 'source', 'enabled', 'created_at', 'updated_at'],
    ))
    expect(cols(live, 'pipeline_ledger')).toEqual(expect.arrayContaining(
      ['id', 'pipeline_run_id', 'stage_key', 'seq', 'ts', 'kind', 'actor', 'goal', 'detail', 'cost'],
    ))
    expect(cols(live, 'pipeline_stages')).toContain('iteration')
    expect(cols(live, 'pipeline_edges')).toContain('max_iterations')
    expect(cols(live, 'pipeline_runs')).toContain('owner_profile_id')
    expect(cols(live, 'skills')).toContain('pipeline_def_id')
  })

  it('NEWEST-COLUMN sentinel: a v14-complete DB stamped 15 (missing only v15 additions) self-heals', () => {
    const d = v14CompleteDb()
    // Guard the guard: this fixture MUST already hold the OLD (v14) sentinel column — if
    // SCHEMA_SENTINEL still named runs.pipeline_stage_id, this poison would evade it.
    expect(cols(d, 'runs')).toContain('pipeline_stage_id')
    expect(hasTable(d, SCHEMA_SENTINEL.table)).toBe(false) // pipeline_ledger doesn't exist yet
    expect(cols(d, 'pipeline_stages')).not.toContain('iteration')
    expect(cols(d, 'pipeline_edges')).not.toContain('max_iterations')
    expect(cols(d, 'pipeline_runs')).not.toContain('owner_profile_id')
    expect(cols(d, 'skills')).not.toContain('pipeline_def_id')
    d.pragma(`user_version = ${SCHEMA_VERSION}`) // the poison
    migrate(d)
    expect(cols(d, 'pipeline_stages')).toContain('iteration')
    expect(cols(d, 'pipeline_edges')).toContain('max_iterations')
    expect(cols(d, 'pipeline_runs')).toContain('owner_profile_id')
    expect(cols(d, 'skills')).toContain('pipeline_def_id')
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })
})
