/**
 * SCHEMA_VERSION 8 (P0 W0) — runs.cli_session_id + projects.verify_recipe.
 *
 * Drives migrate() over a v7-SHAPED fixture DB (runs/projects WITHOUT the new
 * columns, stamped user_version 7) and proves: both columns land, pre-migration
 * rows read back NULL, the stamp moves to 8, double-migrate is idempotent, and
 * the live (fresh-install) DB carries both columns. Also locks the W0 seams:
 * runsDb.setRunCliSessionId and the rowToProject verify_recipe read mapping.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, runsDb, migrate, SCHEMA_VERSION } from '../src/db.js'
import { getProject } from '../src/projects.js'

const colNames = (d: Database.Database, table: string): string[] =>
  (d.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)

describe('migrate() — SCHEMA_VERSION 8 on a v7-shaped DB', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-v8-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('adds runs.cli_session_id + projects.verify_recipe and stamps 8', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // v7-shaped minimal fixture: the two ALTERed tables WITHOUT the new columns.
    // Every other migrateSlow step is hasTable/flag-guarded and no-ops here.
    tempDb.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL,
        github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
        bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', default_branch TEXT,
        health_score INTEGER, last_verified_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        project_id TEXT REFERENCES projects(id), created_at INTEGER NOT NULL, ended_at INTEGER
      );
    `)
    tempDb.prepare(`INSERT INTO runs (id, prompt, cwd, created_at) VALUES ('r-1', 'p', 'c', ?)`).run(Date.now())
    tempDb.pragma('user_version = 7') // a stamped v7 DB → forces the slow scan once

    migrate(tempDb)

    expect(colNames(tempDb, 'runs')).toContain('cli_session_id')
    expect(colNames(tempDb, 'projects')).toContain('verify_recipe')
    // Pre-migration rows read back NULL (the "not captured / none configured" sentinel).
    expect(
      (tempDb.prepare(`SELECT cli_session_id FROM runs WHERE id = 'r-1'`).get() as { cli_session_id: unknown }).cli_session_id,
    ).toBeNull()
    // Stamped to the CURRENT version (8 when this wave landed; derived per the
    // v7-test precedent so later bumps don't break this — the exact v9+ pins
    // live in their own migration tests).
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('double-migrate is idempotent (no duplicate columns, rows intact)', () => {
    tempDb.pragma('user_version = 0') // force the FULL scan again
    expect(() => migrate(tempDb)).not.toThrow()
    expect(colNames(tempDb, 'runs').filter(c => c === 'cli_session_id')).toHaveLength(1)
    expect(colNames(tempDb, 'projects').filter(c => c === 'verify_recipe')).toHaveLength(1)
    expect(tempDb.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 1 })
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})

describe('SCHEMA_VERSION 8 — fresh-install (live boot DB) parity + W0 seams', () => {
  it('the live DB carries both columns', () => {
    expect(colNames(db as unknown as Database.Database, 'runs')).toContain('cli_session_id')
    expect(colNames(db as unknown as Database.Database, 'projects')).toContain('verify_recipe')
  })

  it('runsDb.setRunCliSessionId persists onto a run row', () => {
    const id = uuid()
    runsDb.insertRun.run({
      id, prompt: 'p', cwd: 'C:/tmp', worktree: null, status: 'done', provider: 'claude',
      model: 'claude-haiku-4-5-20251001', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: null, createdAt: Date.now(),
    })
    try {
      runsDb.setRunCliSessionId.run('sess-1', id)
      expect((runsDb.getRun.get(id) as { cli_session_id?: string }).cli_session_id).toBe('sess-1')
    } finally {
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(id)
    }
  })

  it('rowToProject surfaces a valid verify_recipe and drops a malformed one', () => {
    const id = uuid()
    db.prepare(
      `INSERT INTO projects (id, name, local_path, workspace_managed, bible_dir, created_at)
       VALUES (?, ?, ?, 0, 'artifacts/bible', ?)`,
    ).run(id, `p0-vr-${id.slice(0, 8)}`, 'C:/definitely/missing/path', Date.now())
    try {
      const recipe = { commands: [{ label: 'typecheck', run: 'pnpm typecheck' }] }
      db.prepare(`UPDATE projects SET verify_recipe = ? WHERE id = ?`).run(JSON.stringify(recipe), id)
      expect(getProject(id)?.verifyRecipe).toEqual(recipe)
      db.prepare(`UPDATE projects SET verify_recipe = 'not json' WHERE id = ?`).run(id)
      expect(getProject(id)?.verifyRecipe).toBeUndefined()
      db.prepare(`UPDATE projects SET verify_recipe = NULL WHERE id = ?`).run(id)
      expect(getProject(id)?.verifyRecipe).toBeUndefined()
    } finally {
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    }
  })
})
