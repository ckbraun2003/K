/**
 * Campaign S1 — DB pragmas & WAL concurrency (LOCK / characterization).
 *
 * Pins the persistence-core invariants K relies on:
 *  - journal_mode = WAL, foreign_keys = ON, the default 5000ms busy timeout.
 *  - Under WAL a reader on a second connection can read while another connection
 *    holds an open write transaction (readers don't block on the writer).
 *  - A second WRITER against a held write lock gets SQLITE_BUSY ("database is
 *    locked") once its busy timeout elapses.
 *
 * The WAL-lock dance runs against a DEDICATED temp DB file (WAL+FK set to mirror
 * db.ts) rather than the shared k.db, so it can't induce cross-file BUSY contention
 * when the Director runs the whole gating suite in parallel. The pragma assertions
 * run against the real db.ts connection.
 *
 * Findings: S1-001 (pragmas), S1-002 (WAL concurrency).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db } from '../src/db.js'

describe('S1 — db.ts pragmas on the production connection', () => {
  it('journal_mode is WAL', () => {
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
  })

  it('foreign_keys enforcement is ON', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('busy_timeout is the better-sqlite3 default of 5000ms', () => {
    // db.ts does not override the timeout; concurrent writers wait up to 5s for a
    // lock before throwing SQLITE_BUSY. Characterized so a future regression in
    // the default surfaces here.
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
  })
})

describe('S1 — WAL concurrency semantics (dedicated temp file)', () => {
  const dbPath = path.join(os.tmpdir(), `k-s1-wal-${process.pid}-${Date.now()}.db`)
  let writer: Database.Database
  let other: Database.Database

  function mkConn(p: string): Database.Database {
    const d = new Database(p)
    d.pragma('journal_mode = WAL')
    d.pragma('foreign_keys = ON')
    return d
  }

  afterAll(() => {
    try { writer?.close() } catch { /* ignore */ }
    try { other?.close() } catch { /* ignore */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + ext) } catch { /* ignore */ }
    }
  })

  it('a reader on a second connection is not blocked by a held write transaction', () => {
    writer = mkConn(dbPath)
    writer.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
    writer.prepare('INSERT INTO t (id, v) VALUES (?, 1)').run(uuid())

    other = mkConn(dbPath)
    other.pragma('busy_timeout = 50') // fail fast instead of waiting 5s

    writer.prepare('BEGIN IMMEDIATE').run() // acquire + hold the write lock
    try {
      writer.prepare('INSERT INTO t (id, v) VALUES (?, 2)').run(uuid())

      // WAL: the reader sees the last committed snapshot, no BUSY.
      const n = (other.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n
      expect(typeof n).toBe('number')
      expect(n).toBe(1) // the uncommitted second row is not visible to the reader

      // A second writer cannot acquire the lock → SQLITE_BUSY after its timeout.
      expect(() =>
        other.prepare('INSERT INTO t (id, v) VALUES (?, 3)').run(uuid()),
      ).toThrow(/database is locked|SQLITE_BUSY/i)
    } finally {
      writer.prepare('ROLLBACK').run() // release the lock promptly
    }
  })

  it('once the lock is released the previously-BUSY writer succeeds', () => {
    other.prepare('INSERT INTO t (id, v) VALUES (?, 4)').run(uuid())
    const n = (other.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n
    expect(n).toBe(2) // the first committed row + this one
  })
})
