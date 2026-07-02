/**
 * A1 — work_items run-scope migration (mig_work_items_run_scope).
 *
 * Temp DBs (better-sqlite3 + os.tmpdir), modeled on p5-1d-work-item-scope.test.ts /
 * p5-1d2-collapse.test.ts. Pins the one-shot table REBUILD (the OLD scope CHECK can't
 * be altered in place), the legacy personal→run AND org→run re-stamp (both were
 * run-scoped pre-A1), the DEFAULT-'run' backfill, the flag-guarded idempotency (a
 * durable 'personal'/'org' row is never clobbered on a re-boot), post-rebuild indexes,
 * FK integrity (a workflow_steps-style child's link survives the rebuild), and the
 * mid-rebuild ROLLBACK (a poisoned copy leaves the original table fully intact).
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
  const wiOrgId = uuid()

  afterAll(() => {
    try { d?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('(a) re-stamps legacy personal→run AND org→run, rebuilds the CHECK, sets the flag, keeps indexes + FK integrity', () => {
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
    // Legacy 'org' row: pre-A1 'org' was creatable via work_item_create and behaved
    // identically run-scoped — it must re-stamp to 'run' too, or it would silently
    // ESCALATE into the durable operator-global view on the upgrade boot.
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, ?, 'legacy org', 'open', 1, 1, 'org')`).run(wiOrgId, runId)
    d.prepare(`INSERT INTO wsteps (id, work_item_id) VALUES (?, ?)`).run(uuid(), wiId)

    expect(() => migrate(d)).not.toThrow()

    // legacy 'personal' AND 'org' rows re-stamped 'run' (identical ephemeral semantics)
    const row = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(wiId) as { scope: string }
    expect(row.scope).toBe('run')
    const orgRow = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(wiOrgId) as { scope: string }
    expect(orgRow.scope).toBe('run')

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

  it('(b) is a flag-guarded one-shot: durable personal AND org rows survive a re-migrate', () => {
    const durableId = uuid()
    const durableOrgId = uuid()
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, NULL, 'durable personal', 'open', 2, 2, 'personal')`).run(durableId)
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, NULL, 'durable org', 'open', 2, 2, 'org')`).run(durableOrgId)

    expect(() => migrate(d)).not.toThrow()

    // NOT clobbered back to 'run' — the flag makes the →run UPDATE a one-time pass.
    const row = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(durableId) as { scope: string }
    expect(row.scope).toBe('personal')
    const orgRow = d.prepare(`SELECT scope FROM work_items WHERE id = ?`).get(durableOrgId) as { scope: string }
    expect(orgRow.scope).toBe('org')
  })
})

// ── (e): forced mid-transaction failure → full ROLLBACK, nothing half-applied ───

describe('A1 migration: a mid-rebuild failure rolls back atomically', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a1-mig-rollback-${Date.now()}.db`)
  let d: Database.Database
  const goodId = uuid()
  const poisonId = uuid()

  afterAll(() => {
    try { d?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('(e) leaves the ORIGINAL table intact, no work_items_new, flag unset, FKs back ON', () => {
    d = new Database(tmpPath)
    baseSchema(d)
    // Legacy table whose scope column has NO CHECK (its DDL lacks 'run' → the rebuild
    // triggers) seeded with a POISON row whose scope violates the NEW CHECK — the
    // rebuild's INSERT...SELECT copy throws mid-transaction, exercising the rollback.
    d.exec(`
      CREATE TABLE work_items (
        id          TEXT PRIMARY KEY,
        run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'personal'
      );
    `)
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, NULL, 'good', 'open', 1, 1, 'personal')`).run(goodId)
    d.prepare(`INSERT INTO work_items (id, run_id, title, status, created_at, updated_at, scope)
               VALUES (?, NULL, 'poison', 'open', 1, 1, 'bogus')`).run(poisonId)

    // The copy hits the new CHECK on 'bogus' → the whole IMMEDIATE transaction throws…
    expect(() => migrate(d)).toThrow()

    // …and ROLLS BACK: the ORIGINAL table survives with both rows readable…
    const rows = d.prepare(`SELECT id, scope FROM work_items ORDER BY id`).all() as
      Array<{ id: string; scope: string }>
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.id === goodId)?.scope).toBe('personal') // NOT re-stamped
    expect(rows.find(r => r.id === poisonId)?.scope).toBe('bogus')
    // …no half-built work_items_new is left behind…
    expect(
      d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items_new'`).get(),
    ).toBeUndefined()
    // …the one-shot flag was NOT set (the flag commits in the SAME transaction)…
    expect(d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)).toBeUndefined()
    // …FK enforcement was restored by the finally, and integrity is clean.
    expect(d.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(d.pragma('foreign_key_check')).toEqual([])
  })

  it('(e2) recovers: fixing the poison row lets the SAME migration succeed', () => {
    d.prepare(`UPDATE work_items SET scope = 'personal' WHERE id = ?`).run(poisonId)
    expect(() => migrate(d)).not.toThrow()
    // Both legacy rows re-stamped 'run'; flag set; new CHECK accepts 'run'.
    const scopes = (d.prepare(`SELECT scope FROM work_items`).all() as Array<{ scope: string }>).map(r => r.scope)
    expect(scopes).toEqual(['run', 'run'])
    expect(d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)).toBeTruthy()
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
