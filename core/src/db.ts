import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

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

function hasColumn(table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

if (!hasColumn('runs', 'project_id')) {
  // ADD COLUMN with REFERENCES is legal under foreign_keys=ON because the
  // default is NULL; existing rows stay NULL (unassociated)
  db.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id)`)
}

// idx_runs_project must be created after the migration (not inside the main
// db.exec above) so that the column is guaranteed to exist on migrated DBs
// before the index statement runs.
db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)`)

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
const listRuns = db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 100`)
const clearRunWorktree = db.prepare(`UPDATE runs SET worktree = NULL WHERE id = ?`)

export const runsDb = { insertRun, updateRunStatus, getRun, listRuns, clearRunWorktree }

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
  INSERT INTO verification_reports (id, project_id, score, findings, fixes_applied, started_at, completed_at)
  VALUES (@id, @projectId, @score, @findings, @fixesApplied, @startedAt, @completedAt)
`)

const listVerificationReports = db.prepare(`
  SELECT * FROM verification_reports WHERE project_id = ? ORDER BY started_at DESC LIMIT 20
`)

export const verificationDb = { insertVerificationReport, listVerificationReports }

// ─── GitHub cache helpers ────────────────────────────────────────────────────

const upsertGithubCache = db.prepare(`
  INSERT INTO github_cache (project_id, kind, payload, fetched_at)
  VALUES (@projectId, @kind, @payload, @fetchedAt)
  ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`)

const getGithubCache = db.prepare(`SELECT * FROM github_cache WHERE project_id = ? AND kind = ?`)

export const githubDb = { upsertGithubCache, getGithubCache }
