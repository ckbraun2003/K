/**
 * SCHEMA_VERSION 11 (UI Simplification) — k_threads.archived_at, user_memories,
 * memory_saved notification rule, one-shot thread-title backfill.
 * Mirrors db-migration-v10.test.ts: a pre-v11 (v10-shaped) temp DB gains the
 * column/table via migrate(); the rule is seeded; NULL titles backfill from the
 * first user turn exactly once (idempotent — guarded on NULL, never clobbers).
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, migrate, SCHEMA_VERSION } from '../src/db.js'

const tmp: string[] = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.rmSync(f, { recursive: true, force: true }) } catch {} } })

function columns(d: Database.Database, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name)
}
function tables(d: Database.Database): string[] {
  return (d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
}

describe('SCHEMA_VERSION 11', () => {
  it('is 11 and the live test DB has the new shapes', () => {
    expect(SCHEMA_VERSION).toBe(11)
    expect(columns(db as unknown as Database.Database, 'k_threads')).toContain('archived_at')
    expect(tables(db as unknown as Database.Database)).toContain('user_memories')
    const rule = db.prepare(`SELECT inapp, browser FROM notification_rules WHERE event_key='memory_saved'`).get() as { inapp: number; browser: number } | undefined
    expect(rule).toEqual({ inapp: 1, browser: 0 })
  })

  it('migrates a v10-shaped DB: adds archived_at, creates user_memories, seeds the rule, backfills titles once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-v11-')); tmp.push(dir)
    const d = new Database(path.join(dir, 'old.db'))
    d.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE k_threads (
        id TEXT PRIMARY KEY, title TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
        active_run_id TEXT, cli_session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
      CREATE TABLE k_thread_turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES k_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','k')), text TEXT NOT NULL,
        run_id TEXT, created_at INTEGER NOT NULL );
      CREATE TABLE notification_rules ( event_key TEXT PRIMARY KEY, inapp INTEGER NOT NULL DEFAULT 1, browser INTEGER NOT NULL DEFAULT 0 );
      INSERT INTO k_threads (id, title, status, active_run_id, cli_session_id, created_at, updated_at)
        VALUES ('k-default', NULL, 'active', NULL, NULL, 1000, 1000);
      INSERT INTO k_thread_turns (id, thread_id, role, text, run_id, created_at)
        VALUES ('t1', 'k-default', 'user', 'hello there K, plan my week', NULL, 1001),
               ('t2', 'k-default', 'k', 'sure', NULL, 1002);
    `)
    d.pragma('user_version = 10')
    migrate(d)
    expect(d.pragma('user_version', { simple: true })).toBe(11)
    expect(columns(d, 'k_threads')).toContain('archived_at')
    expect(tables(d)).toContain('user_memories')
    const title = (d.prepare(`SELECT title FROM k_threads WHERE id='k-default'`).get() as { title: string }).title
    expect(title).toBe('hello there K, plan my week')
    // idempotence + no clobber: rename, force re-migrate, title must survive
    d.prepare(`UPDATE k_threads SET title='My week' WHERE id='k-default'`).run()
    d.pragma('user_version = 10')
    migrate(d)
    expect((d.prepare(`SELECT title FROM k_threads WHERE id='k-default'`).get() as { title: string }).title).toBe('My week')
    d.close()
  })
})
