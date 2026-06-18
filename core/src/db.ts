import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import type { RunStatus, VerificationReport } from '@k/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.K_DATA_DIR ?? path.join(__dirname, '../../data')

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
    project_id  TEXT REFERENCES projects(id),
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

  CREATE TABLE IF NOT EXISTS projects (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    local_path        TEXT NOT NULL,
    github_remote     TEXT,
    workspace_managed INTEGER NOT NULL DEFAULT 0,
    bible_dir         TEXT NOT NULL DEFAULT 'docs/bible',
    health_score      INTEGER,
    last_verified_at  INTEGER,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verification_reports (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    score         INTEGER NOT NULL,
    findings      TEXT NOT NULL DEFAULT '[]',
    fixes_applied TEXT NOT NULL DEFAULT '[]',
    started_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_verification_project ON verification_reports(project_id, started_at);

  CREATE TABLE IF NOT EXISTS github_cache (
    project_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- 'pr' | 'ci'
    payload     TEXT NOT NULL,            -- JSON array
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, kind)
  );
`)

// ── migrations ───────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS covers fresh installs; existing DBs evolve via
// guarded ALTERs below (pragma table_info check makes them idempotent).
// NB: migrated DBs append new columns at the end — column ORDER may differ
// from a fresh install; always reference columns by name.

function hasColumn(d: Database.Database, table: string, column: string): boolean {
  const cols = d.pragma(`table_info(${table})`) as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasTable(d: Database.Database, table: string): boolean {
  return !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)
}

/** Guarded, idempotent schema evolution — runs at every boot; exported for tests. */
export function migrate(d: Database.Database): void {
  if (!hasColumn(d, 'runs', 'project_id')) {
    // ADD COLUMN with REFERENCES is legal under foreign_keys=ON because the
    // default is NULL; existing rows stay NULL (unassociated)
    d.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  }
  // idx_runs_project must be created after the migration (not inside the main
  // db.exec above) so that the column is guaranteed to exist on migrated DBs
  // before the index statement runs.
  d.exec(`CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)`)
  // range scans for the windowed metrics timeseries query
  d.exec(`CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at)`)
  // verification_reports.score_breakdown: nullable JSON of the per-factor score
  // components. Appended via guarded ALTER (not in CREATE TABLE) so existing DBs
  // gain the column; fresh installs get it here too since migrate() runs at boot.
  // The hasTable guard keeps migrate() callable against DBs predating the table
  // (e.g. minimal old-schema fixtures in db-migration.test.ts).
  if (hasTable(d, 'verification_reports') && !hasColumn(d, 'verification_reports', 'score_breakdown')) {
    d.exec(`ALTER TABLE verification_reports ADD COLUMN score_breakdown TEXT`)
  }
  // events(run_id, seq) must be unique — the lazy raw endpoint does a .get() by
  // (run_id, seq) assuming a single row. SQLite can't ALTER ADD CONSTRAINT, so a
  // unique index is the idiomatic equivalent. Existing dev DBs may already hold
  // duplicate rows (historical bug or manual seeding); creating a unique index
  // over duplicates throws, so dedupe first — keep the lowest rowid per pair.
  if (hasTable(d, 'events')) {
    d.exec(`
      DELETE FROM events
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM events GROUP BY run_id, seq
      )
    `)
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq)`)
  }
}

migrate(db)

// ─── Run helpers ─────────────────────────────────────────────────────────────

const insertRun = db.prepare(`
  INSERT INTO runs (id, prompt, cwd, worktree, status, provider, model, tokens_in, tokens_out, cost_usd, project_id, created_at)
  VALUES (@id, @prompt, @cwd, @worktree, @status, @provider, @model, @tokensIn, @tokensOut, @costUsd, @projectId, @createdAt)
`)

const updateRunStatus = db.prepare(`
  UPDATE runs SET status = @status, tokens_in = @tokensIn, tokens_out = @tokensOut,
    cost_usd = @costUsd, ended_at = @endedAt WHERE id = @id
`)

const getRun = db.prepare(`SELECT * FROM runs WHERE id = ?`)
// Two cached statements: one unfiltered, one with status WHERE — selected at call time
const listRunsAll    = db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
const listRunsStatus = db.prepare(`SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
const clearRunWorktree = db.prepare(`UPDATE runs SET worktree = NULL WHERE id = ?`)

/** Filtered run list. Uses pre-compiled statements — never interpolates values into SQL. */
function listRunsFiltered({ status, limit }: { status?: RunStatus; limit: number }): Array<Record<string, unknown>> {
  if (status !== undefined) {
    return listRunsStatus.all(status, limit) as Array<Record<string, unknown>>
  }
  return listRunsAll.all(limit) as Array<Record<string, unknown>>
}

export const runsDb = { insertRun, updateRunStatus, getRun, listRunsFiltered, clearRunWorktree }

// ─── Event helpers ───────────────────────────────────────────────────────────

// OR IGNORE: the UNIQUE(run_id, seq) index (added in migrate) means a stray
// duplicate seq silently drops instead of throwing into the live event-stream
// handler and aborting the run.
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, run_id, seq, type, ts, raw, text, tool, tokens_in, tokens_out, cost_usd)
  VALUES (@id, @runId, @seq, @type, @ts, @raw, @text, @tool, @tokensIn, @tokensOut, @costUsd)
`)

const listEvents = db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC`)

// Fetch the raw JSON line for a single event — used by the lazy per-event endpoint.
const getEventRaw = db.prepare(`SELECT raw FROM events WHERE run_id = ? AND seq = ?`)

export const eventsDb = { insertEvent, listEvents, getEventRaw }

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

// ─── Project helpers ─────────────────────────────────────────────────────────

const insertProject = db.prepare(`
  INSERT INTO projects (id, name, local_path, github_remote, workspace_managed, bible_dir, created_at)
  VALUES (@id, @name, @localPath, @githubRemote, @workspaceManaged, @bibleDir, @createdAt)
`)

const updateProjectHealth = db.prepare(`
  UPDATE projects SET health_score = @healthScore, last_verified_at = @lastVerifiedAt WHERE id = @id
`)

const getProject = db.prepare(`SELECT * FROM projects WHERE id = ?`)
const listProjects = db.prepare(`SELECT * FROM projects ORDER BY name`)

export const projectsDb = { insertProject, updateProjectHealth, getProject, listProjects }

// ─── Verification helpers ────────────────────────────────────────────────────

const insertVerificationReport = db.prepare(`
  INSERT INTO verification_reports (id, project_id, score, findings, fixes_applied, started_at, completed_at, score_breakdown)
  VALUES (@id, @projectId, @score, @findings, @fixesApplied, @startedAt, @completedAt, @scoreBreakdown)
`)

const listVerificationReports = db.prepare(`
  SELECT * FROM verification_reports WHERE project_id = ? ORDER BY started_at DESC LIMIT 20
`)

export const verificationDb = { insertVerificationReport, listVerificationReports }

/** Map a verification_reports DB row → the shared VerificationReport shape.
 *  snake_case → camelCase; JSON columns parsed; breakdown omitted when NULL.
 *  Null-safe: missing/garbled JSON degrades to empty arrays rather than throwing. */
export function rowToReport(r: Record<string, unknown>): VerificationReport {
  const parseArr = (v: unknown): unknown[] => {
    try {
      const p = JSON.parse(String(v ?? '[]'))
      return Array.isArray(p) ? p : []
    } catch {
      return []
    }
  }
  const report: VerificationReport = {
    id: String(r.id),
    projectId: String(r.project_id),
    score: Number(r.score),
    findings: parseArr(r.findings) as VerificationReport['findings'],
    fixesApplied: parseArr(r.fixes_applied) as string[],
    startedAt: Number(r.started_at),
    completedAt: r.completed_at == null ? undefined : Number(r.completed_at),
  }
  if (r.score_breakdown != null) {
    try {
      report.breakdown = JSON.parse(String(r.score_breakdown))
    } catch {
      /* leave breakdown undefined on garbled JSON */
    }
  }
  return report
}

// ─── GitHub cache helpers ────────────────────────────────────────────────────

const upsertGithubCache = db.prepare(`
  INSERT INTO github_cache (project_id, kind, payload, fetched_at)
  VALUES (@projectId, @kind, @payload, @fetchedAt)
  ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`)

const getGithubCache = db.prepare(`SELECT * FROM github_cache WHERE project_id = ? AND kind = ?`)

export const githubDb = { upsertGithubCache, getGithubCache }
