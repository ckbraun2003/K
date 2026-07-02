/**
 * P5.1d1 — feature tests for the work_items.scope column (D-026), updated for the A1
 * durable operator-global rename (default scope 'personal' → 'run'; project tickets
 * are created via the projects API, not kstore).
 *
 * Two parts:
 *   1. kstore behavior — create defaults scope to 'run', honors an explicit durable
 *      scope, surfaces it through rowToWorkItem/list, rejects a project-scope create,
 *      and zod-rejects a bad value.
 *   2. migrate() — on an old-schema DB that HAS a work_items table (no scope col),
 *      it adds the column (DEFAULT 'run' backfill), is idempotent on a second call,
 *      and does NOT throw when work_items is absent (the hasTable guard).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, runsDb, projectsDb, migrate } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem } from '@k/shared'

// ── kstore scope behavior ─────────────────────────────────────────────────────

describe('P5.1d1: work_item scope column (kstore)', () => {
  const PROJECT_ID = uuid()
  const RUN = uuid()
  const createdWorkItemIds: string[] = []
  const ctx: KStoreContext = { runId: RUN }

  function call(name: string, args: unknown, c: KStoreContext): unknown {
    const tool = kStoreTools.find(t => t.name === name)
    if (!tool) throw new Error(`no such kstore tool: ${name}`)
    return tool.handler(args, c)
  }

  beforeAll(() => {
    projectsDb.insertProject.run({
      id: PROJECT_ID,
      name: `p51d-scope-${PROJECT_ID.slice(0, 8)}`,
      localPath: '/tmp/p51d-scope',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    runsDb.insertRun.run({
      id: RUN,
      prompt: 'p51d scope fixture',
      cwd: '/tmp/p51d-scope',
      worktree: null,
      status: 'running',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: PROJECT_ID,
      createdAt: Date.now(),
    })
  })

  afterAll(() => {
    for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(RUN)
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
  })

  it('create WITHOUT scope defaults to run', () => {
    // The run-scoped default was RENAMED 'personal' → 'run' (identical semantics:
    // ephemeral, visible only to this run).
    const item = call('work_item_create', { title: 'no scope given' }, ctx) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.scope).toBe('run')
  })

  it('create WITH scope:project is REJECTED (project tickets use the projects API)', () => {
    // Project creation moved OFF kstore by design — the pre-parse guard throws.
    expect(() => call('work_item_create', { title: 'scoped', scope: 'project' }, ctx)).toThrow(KStoreError)
  })

  it('rowToWorkItem/list surfaces a durable scope', () => {
    const created = call('work_item_create', { title: 'listed', scope: 'org' }, ctx) as WorkItem
    createdWorkItemIds.push(created.id)
    // durable rows are read via the scope filter (NOT the default run list).
    const list = call('work_item_list', { scope: 'org' }, ctx) as WorkItem[]
    const found = list.find(w => w.id === created.id)!
    expect(found.scope).toBe('org')
  })

  it('an invalid scope value is rejected by zod on create', () => {
    expect(() => call('work_item_create', { title: 'bad scope', scope: 'nope' }, ctx)).toThrow()
  })
})

// ── migrate() adds scope on an old-schema work_items table ────────────────────

describe('P5.1d1: migrate() evolves work_items with scope', () => {
  const tmpPath = path.join(os.tmpdir(), `k-p51d-scope-migration-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds the scope column to an old work_items table (no scope) and is idempotent', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // Old-schema DB: projects+runs (migrate()'s unconditional runs ALTER needs them)
    // plus a pre-scope work_items table.
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
    `)
    // Seed a pre-existing row so the DEFAULT backfill is exercised.
    tempDb
      .prepare(`INSERT INTO work_items (id, run_id, title, body, status, created_at, updated_at)
                VALUES (?, NULL, 'legacy', NULL, 'open', 1, 1)`)
      .run(uuid())

    expect(() => migrate(tempDb)).not.toThrow()
    const cols = tempDb.pragma('table_info(work_items)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('scope')
    // DEFAULT 'run' backfilled the legacy row (the run-scoped default, renamed from
    // 'personal' — identical ephemeral single-run semantics).
    const legacy = tempDb.prepare(`SELECT scope FROM work_items`).get() as { scope: string }
    expect(legacy.scope).toBe('run')

    // Second call is idempotent — must not throw (addColumn skips an existing col).
    // Force the FULL scan: the user_version fast path would otherwise return before
    // the addColumn guard this line exists to exercise.
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
  })

  it('does NOT throw when work_items is absent (hasTable guard)', () => {
    const noTablePath = path.join(os.tmpdir(), `k-p51d-scope-notable-${Date.now()}.db`)
    const noTableDb = new Database(noTablePath)
    try {
      // Old-schema DB with projects+runs (what migrate()'s unconditional runs ALTER
      // needs) but deliberately NO work_items table — the scope ALTER must be skipped
      // by its hasTable guard, so migrate() completes without throwing.
      noTableDb.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
          worktree TEXT, status TEXT NOT NULL DEFAULT 'queued',
          provider TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
          tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ended_at INTEGER
        );
      `)
      expect(() => migrate(noTableDb)).not.toThrow()
      const hasWorkItems = noTableDb
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'`)
        .get()
      expect(hasWorkItems).toBeUndefined()
    } finally {
      try { noTableDb.close() } catch { /* ignore */ }
      try { fs.unlinkSync(noTablePath) } catch { /* ignore */ }
    }
  })
})
