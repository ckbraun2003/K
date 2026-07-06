/**
 * SCHEMA_VERSION 7 (host-integration Wave 0, D-069/D-070/D-071) — the skills
 * catalog columns + the qualified_key UNIQUE move (table REBUILD), plus the two
 * new tables (host_mcp_servers, skill_drafts).
 *
 * Drives migrate() over a v6-SHAPED fixture DB (old skills DDL with UNIQUE(name),
 * FK'd skill_runs/skill_evals rows) and proves:
 *   - every new column exists; qualified_key backfilled = name;
 *   - UNIQUE genuinely MOVED: two rows may share a name under different
 *     qualified keys, while a duplicate qualified_key still throws;
 *   - the rebuild preserves row ids — the FK'd skill_runs/skill_evals rows
 *     survive intact (foreign_key_check clean);
 *   - double-migrate is idempotent; user_version stamps 7;
 *   - host_mcp_servers + skill_drafts exist on BOTH the migrated fixture and the
 *     fresh-install live DB (their CHECK constraints enforced).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, skillsDb, migrate, SCHEMA_VERSION } from '../src/db.js'

const colNames = (d: Database.Database, table: string): string[] =>
  (d.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)

const hasTable = (d: Database.Database, table: string): boolean =>
  !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)

const NEW_SKILL_COLUMNS = [
  'source_kind', 'origin_path', 'project_id', 'plugin_id', 'plugin_version',
  'content_hash', 'est_tokens', 'est_tokens_meta', 'status', 'last_scanned_at',
  'qualified_key',
] as const

describe('migrate() — SCHEMA_VERSION 7 on a v6-shaped DB (skills rebuild + new tables)', () => {
  const tmpPath = path.join(os.tmpdir(), `k-migration-v7-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('sets up the v6 fixture, migrates, and lands the full catalog schema', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')

    // v6-shaped fixture: OLD skills DDL (UNIQUE on name, none of the catalog
    // columns) + the FK'd history tables + the tables migrate() ALTERs.
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE skills (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        description  TEXT,
        type         TEXT NOT NULL CHECK(type IN ('skill','hook','workflow')),
        source       TEXT NOT NULL,
        triggerType  TEXT NOT NULL CHECK(triggerType IN ('manual','schedule','event')),
        schedule     TEXT,
        eventTrigger TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        createdAt    INTEGER NOT NULL
      );
      CREATE TABLE skill_runs (
        id          TEXT PRIMARY KEY,
        skillId     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        runId       TEXT REFERENCES runs(id) ON DELETE SET NULL,
        triggeredBy TEXT NOT NULL,
        startedAt   INTEGER NOT NULL,
        completedAt INTEGER,
        status      TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed'))
      );
      CREATE TABLE skill_evals (
        id             TEXT PRIMARY KEY,
        skillId        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        runId          TEXT REFERENCES runs(id) ON DELETE SET NULL,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail')),
        regression     INTEGER NOT NULL DEFAULT 0,
        baselineEvalId TEXT REFERENCES skill_evals(id) ON DELETE SET NULL,
        createdAt      INTEGER NOT NULL,
        completedAt    INTEGER
      );
    `)

    // Pre-migration rows: two skills, each with FK'd history hanging off it.
    const now = Date.now()
    const ins = tempDb.prepare(
      `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt)
       VALUES (?, ?, NULL, 'workflow', 'src', 'manual', 1, ?)`,
    )
    ins.run('sk-a', 'alpha', now)
    ins.run('sk-b', 'beta', now)
    tempDb.prepare(
      `INSERT INTO skill_runs (id, skillId, runId, triggeredBy, startedAt, status)
       VALUES ('sr-1', 'sk-a', NULL, 'manual', ?, 'completed')`,
    ).run(now)
    tempDb.prepare(
      `INSERT INTO skill_evals (id, skillId, runId, status, regression, createdAt)
       VALUES ('se-1', 'sk-b', NULL, 'pass', 0, ?)`,
    ).run(now)
    const rowidsBefore = tempDb
      .prepare(`SELECT id, rowid FROM skills ORDER BY id`)
      .all() as Array<{ id: string; rowid: number }>

    tempDb.pragma('user_version = 6') // a stamped v6 DB → forces the slow scan once

    migrate(tempDb)

    // (a) every catalog column exists.
    const cols = colNames(tempDb, 'skills')
    for (const c of NEW_SKILL_COLUMNS) expect(cols).toContain(c)

    // (b) qualified_key backfilled = name; defaults landed (source_kind 'k', status 'ok').
    const rows = tempDb
      .prepare(`SELECT id, name, qualified_key, source_kind, status FROM skills ORDER BY id`)
      .all() as Array<{ id: string; name: string; qualified_key: string; source_kind: string; status: string }>
    expect(rows).toEqual([
      { id: 'sk-a', name: 'alpha', qualified_key: 'alpha', source_kind: 'k', status: 'ok' },
      { id: 'sk-b', name: 'beta', qualified_key: 'beta', source_kind: 'k', status: 'ok' },
    ])

    // (c) the rebuild happened: sqlite_master no longer carries UNIQUE on name.
    const ddl = (tempDb.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'`)
      .get() as { sql: string }).sql
    expect(ddl).not.toMatch(/\bname\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i)
    expect(ddl).toMatch(/qualified_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)

    // (d) row ids preserved (skill_runs/skill_evals FK into skills).
    const rowidsAfter = tempDb
      .prepare(`SELECT id, rowid FROM skills ORDER BY id`)
      .all() as Array<{ id: string; rowid: number }>
    expect(rowidsAfter).toEqual(rowidsBefore)

    // (e) user_version stamped to the CURRENT version — and that version is 7.
    expect(SCHEMA_VERSION).toBe(7)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(7)
  })

  it('UNIQUE genuinely moved: same name under two qualified keys OK; dup key throws', () => {
    const now = Date.now()
    const ins = tempDb.prepare(
      `INSERT INTO skills (id, name, type, source, triggerType, enabled, createdAt, source_kind, qualified_key)
       VALUES (?, ?, 'skill', 'src', 'manual', 1, ?, ?, ?)`,
    )
    // Two DIFFERENT sources may now offer the SAME skill name (D-069).
    ins.run('sk-c', 'tdd', now, 'k', 'tdd')
    expect(() => ins.run('sk-d', 'tdd', now, 'claude-user', 'user:tdd')).not.toThrow()
    // …but the canonical key itself stays unique.
    expect(() => ins.run('sk-e', 'tdd-again', now, 'claude-user', 'user:tdd')).toThrow(/UNIQUE/i)
    // NOT NULL is enforced post-rebuild.
    expect(() =>
      tempDb.prepare(
        `INSERT INTO skills (id, name, type, source, triggerType, enabled, createdAt)
         VALUES ('sk-f', 'nokey', 'skill', 'src', 'manual', 1, ?)`,
      ).run(now),
    ).toThrow(/NOT NULL/i)
  })

  it('FK integrity survives the rebuild: history rows still resolve; cascade still works', () => {
    // No dangling references anywhere after the FKs-OFF rebuild window.
    expect(tempDb.pragma('foreign_key_check')).toEqual([])
    // The FK'd rows still join to their (id-preserved) skills.
    const joined = tempDb
      .prepare(
        `SELECT sr.id AS srId, s.name AS runSkill, se.id AS seId, s2.name AS evalSkill
         FROM skill_runs sr JOIN skills s ON s.id = sr.skillId,
              skill_evals se JOIN skills s2 ON s2.id = se.skillId`,
      )
      .get() as { srId: string; runSkill: string; seId: string; evalSkill: string }
    expect(joined).toEqual({ srId: 'sr-1', runSkill: 'alpha', seId: 'se-1', evalSkill: 'beta' })
    // ON DELETE CASCADE still fires through the rebuilt parent.
    tempDb.prepare(`DELETE FROM skills WHERE id = 'sk-b'`).run()
    expect(tempDb.prepare(`SELECT COUNT(*) AS n FROM skill_evals`).get()).toEqual({ n: 0 })
  })

  it('creates host_mcp_servers + skill_drafts on the migrated DB (CHECKs enforced)', () => {
    expect(hasTable(tempDb, 'host_mcp_servers')).toBe(true)
    expect(hasTable(tempDb, 'skill_drafts')).toBe(true)

    const now = Date.now()
    // host_mcp_servers: valid insert OK; enabled defaults 0; bad source_kind refused.
    tempDb.prepare(
      `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, command, config_hash, discovered_at)
       VALUES ('hm-1', 'srv', 'user:srv', 'claude-user', 'npx', 'h1', ?)`,
    ).run(now)
    expect(
      (tempDb.prepare(`SELECT enabled FROM host_mcp_servers WHERE id = 'hm-1'`).get() as { enabled: number }).enabled,
    ).toBe(0) // default-disabled (D-070)
    expect(() =>
      tempDb.prepare(
        `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, command, config_hash, discovered_at)
         VALUES ('hm-2', 'srv2', 'plugin:x@y:srv2', 'claude-plugin', 'npx', 'h2', ?)`,
      ).run(now),
    ).toThrow(/CHECK/i) // only claude-user | claude-project (D-070)

    // skill_drafts: status CHECK enforced; revision defaults 0.
    tempDb.prepare(
      `INSERT INTO skill_drafts (id, brief, created_at, updated_at) VALUES ('dr-1', 'write a skill', ?, ?)`,
    ).run(now, now)
    const draft = tempDb
      .prepare(`SELECT status, revision FROM skill_drafts WHERE id = 'dr-1'`)
      .get() as { status: string; revision: number }
    expect(draft).toEqual({ status: 'drafting', revision: 0 })
    expect(() =>
      tempDb.prepare(
        `INSERT INTO skill_drafts (id, brief, status, created_at, updated_at) VALUES ('dr-2', 'x', 'bogus', ?, ?)`,
      ).run(now, now),
    ).toThrow(/CHECK/i)
  })

  it('double-migrate is idempotent — no re-rebuild, no duplicate columns, rows intact', () => {
    const before = tempDb.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    tempDb.pragma('user_version = 0') // force the FULL scan again
    expect(() => migrate(tempDb)).not.toThrow()
    expect(
      (tempDb.pragma('table_info(skills)') as Array<{ name: string }>).filter(c => c.name === 'qualified_key'),
    ).toHaveLength(1)
    expect(tempDb.prepare(`SELECT COUNT(*) AS n FROM skills`).get()).toEqual(before)
    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})

describe('SCHEMA_VERSION 7 — fresh-install (live boot DB) parity', () => {
  it('the live DB carries the catalog columns and both new tables', () => {
    const cols = colNames(db as unknown as Database.Database, 'skills')
    for (const c of NEW_SKILL_COLUMNS) expect(cols).toContain(c)
    expect(hasTable(db as unknown as Database.Database, 'host_mcp_servers')).toBe(true)
    expect(hasTable(db as unknown as Database.Database, 'skill_drafts')).toBe(true)
  })

  it('the live skills table has UNIQUE on qualified_key, not on name', () => {
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'`)
      .get() as { sql: string }).sql
    expect(ddl).toMatch(/qualified_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
    expect(ddl).not.toMatch(/\bname\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i)
  })

  it('the automation registry stays k-scoped: a discovered row is INVISIBLE to listSkills/getSkillByName', () => {
    // The D-069 back-compat lock: name is no longer unique across SOURCES, so the
    // pre-v7 surfaces (GET /api/skills list, the POST/PATCH name-collision
    // pre-check, seedBuiltinSkills) must see ONLY source_kind='k' rows — a
    // discovered `user:<name>` row must neither list nor 409 a k-native create.
    const name = `w0-discovered-${uuid().slice(0, 8)}`
    const id = uuid()
    db.prepare(
      `INSERT INTO skills (id, name, type, source, triggerType, enabled, createdAt, source_kind, qualified_key, origin_path)
       VALUES (?, ?, 'skill', 'discovered SKILL.md', 'manual', 0, ?, 'claude-user', ?, '/host/skills')`,
    ).run(id, name, Date.now(), `user:${name}`)
    try {
      expect(skillsDb.getSkillByName.get(name)).toBeUndefined()
      const listed = skillsDb.listSkills.all() as Array<{ id: string }>
      expect(listed.some(r => r.id === id)).toBe(false)
      // …while a by-id fetch (an explicit handle) still resolves the row.
      expect(skillsDb.getSkill.get(id)).toBeDefined()
    } finally {
      db.prepare(`DELETE FROM skills WHERE id = ?`).run(id)
    }
  })
})
