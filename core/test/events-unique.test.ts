/**
 * C3 — UNIQUE(run_id, seq) + ingest validation.
 *  - migrate() dedupes existing duplicate (run_id, seq) rows (keeping lowest
 *    rowid) and creates a unique index that rejects subsequent dup inserts.
 *  - parseLine() drops AgentEventSchema-invalid lines (no throw, returns null).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { migrate } from '../src/db.js'
import { parseLine } from '../src/supervisor.js'

const tmpPath = path.join(os.tmpdir(), `k-events-unique-${Date.now()}.db`)
let tempDb: Database.Database

afterAll(() => {
  try { tempDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
})

describe('migrate() — events(run_id, seq) uniqueness', () => {
  const RUN = uuid()

  it('dedupes pre-existing duplicate rows then creates the unique index', () => {
    tempDb = new Database(tmpPath)
    // Old-schema-ish DB: a runs table (so migrate()'s guarded runs ALTERs run)
    // plus an events table WITHOUT the unique index, seeded WITH a duplicate
    // (run_id, seq) pair — simulating a historical dev DB.
    tempDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        type TEXT NOT NULL, ts INTEGER NOT NULL, raw TEXT, text TEXT, tool TEXT,
        tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL
      );
    `)
    const ins = tempDb.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'status', 0, ?)`,
    )
    ins.run(uuid(), RUN, 1, 'first')   // lowest rowid — kept
    ins.run(uuid(), RUN, 1, 'dup')     // duplicate (run_id, seq) — removed
    ins.run(uuid(), RUN, 2, 'other')

    migrate(tempDb)

    const rows = tempDb.prepare('SELECT text FROM events WHERE run_id = ? AND seq = 1').all(RUN)
    expect(rows).toHaveLength(1)
    expect((rows[0] as { text: string }).text).toBe('first') // lowest rowid survived

    const indexes = tempDb.pragma('index_list(events)') as Array<{ name: string }>
    expect(indexes.map(i => i.name)).toContain('idx_events_run_seq')
  })

  it('the unique index rejects a subsequent duplicate (run_id, seq) insert', () => {
    const ins = tempDb.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts) VALUES (?, ?, ?, 'status', 0)`,
    )
    // (RUN, 2) already exists → unique index must reject this insert
    expect(() => ins.run(uuid(), RUN, 2)).toThrow(/UNIQUE/i)
  })

  it('migrate() is idempotent against the deduped DB', () => {
    // Force the FULL scan — the user_version fast path would otherwise skip the
    // dedupe+index branch this case exists to re-run.
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
  })
})

describe('parseLine — ingest validation', () => {
  it('drops a line whose parsed event fails AgentEventSchema (non-uuid runId)', () => {
    // Valid JSON, valid structure — but runId is not a uuid, so AgentEventSchema
    // rejects it. Must return null (dropped), never throw.
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } })
    expect(parseLine(line, 'not-a-uuid', 1)).toBeNull()
  })

  it('still returns a valid event for a well-formed line with a uuid runId', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    const ev = parseLine(line, uuid(), 1)
    expect(ev).not.toBeNull()
    expect(ev!.text).toBe('hi')
  })

  it('drops malformed JSON without throwing', () => {
    expect(parseLine('{not json', uuid(), 1)).toBeNull()
  })
})
