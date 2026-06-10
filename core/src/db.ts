import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../../data')

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'k.db'))

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    prompt      TEXT NOT NULL,
    cwd         TEXT NOT NULL,
    worktree    TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',
    provider    TEXT NOT NULL DEFAULT 'claude',
    model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    ended_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    seq         INTEGER NOT NULL,
    type        TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    raw         TEXT,
    text        TEXT,
    tool        TEXT,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    cost_usd    REAL
  );
  CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id, seq);

  CREATE TABLE IF NOT EXISTS artifacts (
    slug        TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    phase       TEXT,
    status      TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    linked_run_id TEXT,
    updated_at  INTEGER NOT NULL,
    md          TEXT NOT NULL
  );
`)

// ─── Run helpers ─────────────────────────────────────────────────────────────

const insertRun = db.prepare(`
  INSERT INTO runs (id, prompt, cwd, worktree, status, provider, model, tokens_in, tokens_out, cost_usd, created_at)
  VALUES (@id, @prompt, @cwd, @worktree, @status, @provider, @model, @tokensIn, @tokensOut, @costUsd, @createdAt)
`)

const updateRunStatus = db.prepare(`
  UPDATE runs SET status = @status, tokens_in = @tokensIn, tokens_out = @tokensOut,
    cost_usd = @costUsd, ended_at = @endedAt WHERE id = @id
`)

const getRun = db.prepare(`SELECT * FROM runs WHERE id = ?`)
const listRuns = db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 100`)

export const runsDb = { insertRun, updateRunStatus, getRun, listRuns }

// ─── Event helpers ───────────────────────────────────────────────────────────

const insertEvent = db.prepare(`
  INSERT INTO events (id, run_id, seq, type, ts, raw, text, tool, tokens_in, tokens_out, cost_usd)
  VALUES (@id, @runId, @seq, @type, @ts, @raw, @text, @tool, @tokensIn, @tokensOut, @costUsd)
`)

const listEvents = db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC`)

export const eventsDb = { insertEvent, listEvents }

// ─── Artifact helpers ─────────────────────────────────────────────────────────

const upsertArtifact = db.prepare(`
  INSERT INTO artifacts (slug, title, phase, status, tags, linked_run_id, updated_at, md)
  VALUES (@slug, @title, @phase, @status, @tags, @linkedRunId, @updatedAt, @md)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title,
    phase = excluded.phase,
    status = excluded.status,
    tags = excluded.tags,
    linked_run_id = excluded.linked_run_id,
    updated_at = excluded.updated_at,
    md = excluded.md
`)

const getArtifact = db.prepare(`SELECT * FROM artifacts WHERE slug = ?`)
const listArtifacts = db.prepare(`SELECT slug, title, phase, status, tags, updated_at FROM artifacts ORDER BY updated_at DESC`)

export const artifactsDb = { upsertArtifact, getArtifact, listArtifacts }
