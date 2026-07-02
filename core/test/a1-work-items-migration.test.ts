/**
 * A1 — work_items run-scope migration (mig_work_items_run_scope).
 *
 * Temp DBs (better-sqlite3 + os.tmpdir), modeled on p5-1d-work-item-scope.test.ts /
 * p5-1d2-collapse.test.ts. Pins the one-shot table REBUILD (the OLD scope CHECK can't
 * be altered in place), the DEFAULT-'run' backfill, the flag-guarded idempotency (a
 * durable 'personal' row is never clobbered on a re-boot), post-rebuild indexes, and
 * FK integrity (a workflow_steps-style child's link survives the rebuild).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { migrate } from '../src/db.js'

const RUN_SCOPE_FLAG = 'mig_work_items_run_scope'

/** projects + runs (what migrate()'s unconditional runs ALTER + FK targets need). */
function baseSchema(d: Database.Database): void {
  d.pragma('foreign_keys = ON')
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
      status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, ended_at INTEGER
    );
  `)
}

// ── (a)+(b): old-CHECK scope column → REBUILD + one-shot guard ─────────────────

describe('A1 migration: rebuilds a work_items carrying the OLD scope CHECK', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a1-mig-rebuild-${Date.now()}.db`)
  let d: Database.Database
  const wiId = uuid()

  afterAll(() => {
    try { d?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('(a) re-stamps legacy personal→run, rebuilds the CHECK, sets the flag, keeps indexes + FK integrity', () => {
    d = new Database(tmpPath)
    baseSchema(d)
    // OLD-schema work_items: the pre-A1 scope column (DEFAULT 'personal', CHECK without
    // 'run') + a workflow_steps-style child referencing it (ON DELETE SET NULL).
    d.exec(`
      CREATE TABLE work_items (
        id          TEXT PRIMARY KEY,
        run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','org','project'))
      );
      CREATE TABLE wsteps (
        id           TEXT PRIMARY KEY,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL
      );
    `)
    const runId = uuid()
    d.prepare(`INSERT INTO runs (id, prompt, cwd, created_at) VALUES (?, 'x', '.', 1)`).run(runId)
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, ?, 'legacy', 'open', 1, 1, 'personal')`).run(wiId, runId)
    d.prepare(`INSERT INTO wsteps (id, work_item_id) VALUES (?, ?)`).run(uuid(), wiId)

    expect(() => migrate(d)).not.toThrow()

    // legacy 'personal' rows re-stamped 'run' (identical ephemeral semantics)
    const row = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(wiId) as { scope: string }
    expect(row.scope).toBe('run')

    // the CHECK was rebuilt: a scope='run' INSERT now succeeds (would have failed the old CHECK)
    expect(() =>
      d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
                 VALUES (?, NULL, 't', 'open', 1, 1, 'run')`).run(uuid()),
    ).not.toThrow()

    // the one-shot flag is set
    const flag = d.prepare(`SELECT value FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)
    expect(flag).toBeTruthy()

    // indexes recreated post-rebuild
    const idx = (d.pragma('index_list(work_items)') as Array<{ name: string }>).map(i => i.name)
    expect(idx).toContain('idx_work_items_run')
    expect(idx).toContain('idx_work_items_project')
    expect(idx).toContain('idx_work_items_issue')

    // FK integrity: the child's link was preserved (ids kept through copy-drop-rename),
    // so foreign_key_check finds no dangling references.
    expect(d.pragma('foreign_key_check')).toEqual([])
    const ws = d.prepare(`SELECT work_item_id FROM wsteps`).get() as { work_item_id: string | null }
    expect(ws.work_item_id).toBe(wiId)
  })

  it('(b) is a flag-guarded one-shot: a durable personal row survives a re-migrate', () => {
    const durableId = uuid()
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, NULL, 'durable personal', 'open', 2, 2, 'personal')`).run(durableId)

    expect(() => migrate(d)).not.toThrow()

    // NOT clobbered back to 'run' — the flag makes the personal→run UPDATE a one-time pass.
    const row = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(durableId) as { scope: string }
    expect(row.scope).toBe('personal')
  })
})

// ── (c): pre-scope DB (no scope column) → new-enum column, legacy row 'run' ─────

describe('A1 migration: pre-scope DB gains the new-enum column with DEFAULT run', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a1-mig-prescope-${Date.now()}.db`)
  let d: Database.Database

  afterAll(() => {
    try { d?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds scope (no rebuild) and backfills the legacy row to run', () => {
    d = new Database(tmpPath)
    baseSchema(d)
    d.exec(`
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, body TEXT,
        status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    const legacyId = uuid()
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at)
               VALUES (?, NULL, 'legacy', 'open', 1, 1)`).run(legacyId)

    expect(() => migrate(d)).not.toThrow()

    const cols = (d.pragma('table_info(work_items)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('scope')
    const row = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(legacyId) as { scope: string }
    expect(row.scope).toBe('run')
    expect(d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)).toBeTruthy()
  })
})

// ── (d): no work_items table → no throw, flag NOT set ──────────────────────────

describe('A1 migration: tolerates a missing work_items table', () => {
  it('does not throw and does not set the run-scope flag', () => {
    const p = path.join(os.tmpdir(), `k-a1-mig-notable-${Date.now()}.db`)
    const d = new Database(p)
    try {
      baseSchema(d)
      expect(() => migrate(d)).not.toThrow()
      const hasWorkItems = d
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'`)
        .get()
      expect(hasWorkItems).toBeUndefined()
      // app_config exists (created unconditionally) but the flag was NOT set
      expect(d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)).toBeUndefined()
    } finally {
      try { d.close() } catch { /* ignore */ }
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })
})
