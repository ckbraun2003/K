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
    cost_usd    REAL,
    tool_use_id          TEXT,
    tool_kind            TEXT,
    tool_input           TEXT,
    tool_result          TEXT,
    tool_result_is_error INTEGER,
    subagent_type        TEXT,
    child_label          TEXT,
    context_tokens       INTEGER
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
    bible_dir         TEXT NOT NULL DEFAULT 'artifacts/bible',
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

  CREATE TABLE IF NOT EXISTS project_tasks (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id, created_at);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
    task_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
    mode         TEXT NOT NULL DEFAULT 'combined',
    status       TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(project_id, created_at);

  CREATE TABLE IF NOT EXISTS skills (
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

  CREATE TABLE IF NOT EXISTS skill_runs (
    id          TEXT PRIMARY KEY,
    skillId     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    runId       TEXT REFERENCES runs(id) ON DELETE SET NULL,
    triggeredBy TEXT NOT NULL,
    startedAt   INTEGER NOT NULL,
    completedAt INTEGER,
    status      TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed'))
  );

  CREATE TABLE IF NOT EXISTS skill_evals (
    id             TEXT PRIMARY KEY,
    skillId        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    runId          TEXT REFERENCES runs(id) ON DELETE SET NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail')),
    regression     INTEGER NOT NULL DEFAULT 0,
    baselineEvalId TEXT REFERENCES skill_evals(id) ON DELETE SET NULL,
    createdAt      INTEGER NOT NULL,
    completedAt    INTEGER
  );

  -- Per-project knowledge-graph build state (Phase H). The graph data lives in the
  -- project's .gitnexus/ dir; this table tracks build status/freshness only.
  CREATE TABLE IF NOT EXISTS project_graphs (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','building','ready','error')),
    built_at    INTEGER,
    last_commit TEXT,
    node_count  INTEGER NOT NULL DEFAULT 0,
    edge_count  INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    updated_at  INTEGER NOT NULL
  );

  -- Runtime config store (Wave 1): persisted key/value pairs that override boot-time
  -- env constants without requiring a server restart. Keys are namespaced dotted
  -- strings (e.g. 'ollama.enabled'). Writers UPSERT; readers fall back to env.
  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ── kstore (Phase 5) ───────────────────────────────────────────────────────
  -- The working store managed agents reach through the kstore MCP server, in
  -- place of the home-dev tasks/*.md files. work_items = tickets; agent_memory =
  -- gated lessons (layer A); workflow_steps = the live status/progress checklist.

  -- A ticket. run_id is the managed run that created it (resolved from K_RUN_ID);
  -- ON DELETE SET NULL keeps the ticket if its run is later removed.
  CREATE TABLE IF NOT EXISTS work_items (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    status      TEXT NOT NULL DEFAULT 'open'
                  CHECK(status IN ('open','in_progress','blocked','done','cancelled')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_items_run ON work_items(run_id, created_at);

  -- A proposed lesson, held 'pending' until an operator accepts it (gated
  -- reflection). run_id SET NULL on run delete so durable memory outlives the run.
  CREATE TABLE IF NOT EXISTS agent_memory (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    lesson      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','accepted','rejected')),
    created_at  INTEGER NOT NULL,
    reviewed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON agent_memory(status, created_at);

  -- One checklist line keyed to a workflow_runs row. UNIQUE(workflow_run_id,label)
  -- makes the label the upsert key (workflow_step_set upserts by label per run).
  -- Cascades with its workflow_run; work_item_id SET NULL if the linked ticket goes.
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id              TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    label           TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK(kind IN ('task','phase','review','ci')),
    work_item_id    TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','in_progress','done','blocked','failed')),
    detail          TEXT,
    updated_at      INTEGER NOT NULL,
    UNIQUE(workflow_run_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(workflow_run_id, seq);
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

/** Idempotent, race-tolerant ADD COLUMN: skips if present, and tolerates a
 *  concurrent connection having just added it (better-sqlite3 throws
 *  'duplicate column name'). Any other error still propagates. */
function addColumn(d: Database.Database, table: string, col: string, decl: string): void {
  if (hasColumn(d, table, col)) return
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e
  }
}

/** Guarded, idempotent schema evolution — runs at every boot; exported for tests. */
export function migrate(d: Database.Database): void {
  // ADD COLUMN with REFERENCES is legal under foreign_keys=ON because the
  // default is NULL; existing rows stay NULL (unassociated). Routed through the
  // race-tolerant addColumn() so a concurrent first-boot that just added it can't
  // crash this connection with 'duplicate column name'.
  addColumn(d, 'runs', 'project_id', 'TEXT REFERENCES projects(id)')
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
  if (hasTable(d, 'verification_reports')) {
    addColumn(d, 'verification_reports', 'score_breakdown', 'TEXT')
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
  // events enriched tool-metadata columns (Wave D3): appended via guarded ALTERs
  // (not only in CREATE TABLE) so existing DBs gain them; fresh installs get them
  // from the DDL above too since migrate() runs at boot. hasTable guard keeps
  // migrate() safe against old-schema fixtures predating the table.
  if (hasTable(d, 'events')) {
    addColumn(d, 'events', 'tool_use_id', 'TEXT')
    addColumn(d, 'events', 'tool_kind', 'TEXT')
    addColumn(d, 'events', 'tool_input', 'TEXT')
    addColumn(d, 'events', 'tool_result', 'TEXT')
    addColumn(d, 'events', 'tool_result_is_error', 'INTEGER')
    addColumn(d, 'events', 'subagent_type', 'TEXT')
    addColumn(d, 'events', 'child_label', 'TEXT')
    // context_tokens (Wave D6): full input context size for the turn (fresh +
    // cache_creation + cache_read) powering the context-pressure indicator, so a
    // reloaded historical run shows the pressure it actually reached.
    addColumn(d, 'events', 'context_tokens', 'INTEGER')
  }
  // project_tasks GitHub Issues sync columns (Wave 3-7): appended via guarded
  // ALTERs (not in CREATE TABLE) so existing DBs gain them; fresh installs get
  // them here too since migrate() runs at boot. hasTable guard keeps migrate()
  // safe against old-schema fixtures predating the table.
  if (hasTable(d, 'project_tasks')) {
    addColumn(d, 'project_tasks', 'issue_number', 'INTEGER')
    addColumn(d, 'project_tasks', 'issue_url', 'TEXT')
    addColumn(d, 'project_tasks', 'issue_state', 'TEXT')
    d.exec(`CREATE INDEX IF NOT EXISTS idx_project_tasks_issue ON project_tasks(project_id, issue_number)`)
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
const listRunsAll           = db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
const listRunsStatus        = db.prepare(`SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
const listRunsProject       = db.prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
const listRunsProjectStatus = db.prepare(`SELECT * FROM runs WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`)
const clearRunWorktree = db.prepare(`UPDATE runs SET worktree = NULL WHERE id = ?`)

/** Filtered run list. Uses pre-compiled statements — never interpolates values into SQL. */
function listRunsFiltered({ status, limit, projectId }: { status?: RunStatus; limit: number; projectId?: string }): Array<Record<string, unknown>> {
  if (projectId !== undefined && status !== undefined) {
    return listRunsProjectStatus.all(projectId, status, limit) as Array<Record<string, unknown>>
  }
  if (projectId !== undefined) {
    return listRunsProject.all(projectId, limit) as Array<Record<string, unknown>>
  }
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
  INSERT OR IGNORE INTO events (id, run_id, seq, type, ts, raw, text, tool, tokens_in, tokens_out, cost_usd,
    tool_use_id, tool_kind, tool_input, tool_result, tool_result_is_error, subagent_type, child_label, context_tokens)
  VALUES (@id, @runId, @seq, @type, @ts, @raw, @text, @tool, @tokensIn, @tokensOut, @costUsd,
    @toolUseId, @toolKind, @toolInput, @toolResult, @toolResultIsError, @subagentType, @childLabel, @contextTokens)
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

// Count runs still in flight for a project. The delete route refuses while any
// are live so we never delete a run row out from under the supervisor (its next
// event INSERT would FK-fail against a now-missing run). 'awaiting_input' is an
// interactive run parked on stdin — still live (holds a worktree, writes events),
// so it counts as active too.
const countActiveProjectRuns = db.prepare(
  `SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN ('running','queued','awaiting_input')`,
)

// Hard-delete a project and everything hanging off it. project_tasks,
// workflow_runs and project_graphs cascade automatically (ON DELETE CASCADE); but
// runs, verification_reports, a run's events, and github_cache have NO cascade, so
// they're cleaned explicitly in FK-safe order inside one transaction. Deleting the
// runs first lets workflow_runs.run_id (ON DELETE SET NULL) resolve before the
// project row (and its workflow_runs) cascade away.
//
// skill_runs/skill_evals are deliberately NOT touched: they are SKILL-scoped history
// (anchored to skills.id), and skill-triggered runs are launched with no projectId
// (skills.ts startRun(skill.source)) so they carry project_id = NULL and are never
// matched by deleteProjectRuns. If a future skill ever dispatched a project-scoped
// run, runs(id)'s ON DELETE SET NULL on skill_runs/skill_evals correctly preserves
// the skill's execution history rather than erasing it on a project delete.
const deleteProjectRunEvents = db.prepare(
  `DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`,
)
const deleteProjectRuns = db.prepare(`DELETE FROM runs WHERE project_id = ?`)
const deleteProjectReports = db.prepare(`DELETE FROM verification_reports WHERE project_id = ?`)
const deleteProjectGithubCache = db.prepare(`DELETE FROM github_cache WHERE project_id = ?`)
const deleteProjectRow = db.prepare(`DELETE FROM projects WHERE id = ?`)
const deleteProject = db.transaction((id: string) => {
  deleteProjectRunEvents.run(id)
  deleteProjectRuns.run(id)
  deleteProjectReports.run(id)
  deleteProjectGithubCache.run(id)
  deleteProjectRow.run(id) // cascades project_tasks, workflow_runs, project_graphs
})

export const projectsDb = {
  insertProject,
  updateProjectHealth,
  getProject,
  listProjects,
  countActiveProjectRuns,
  deleteProject,
}

// ─── Project graph helpers ───────────────────────────────────────────────────

const upsertProjectGraph = db.prepare(`
  INSERT INTO project_graphs (project_id, status, built_at, last_commit, node_count, edge_count, error, updated_at)
  VALUES (@projectId, @status, @builtAt, @lastCommit, @nodeCount, @edgeCount, @error, @updatedAt)
  ON CONFLICT(project_id) DO UPDATE SET
    status      = excluded.status,
    built_at    = excluded.built_at,
    last_commit = excluded.last_commit,
    node_count  = excluded.node_count,
    edge_count  = excluded.edge_count,
    error       = excluded.error,
    updated_at  = excluded.updated_at
`)

const getProjectGraph = db.prepare(`SELECT * FROM project_graphs WHERE project_id = ?`)

export const projectGraphsDb = { upsertProjectGraph, getProjectGraph }

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

// ─── ProjectTask helpers ─────────────────────────────────────────────────────

const insertProjectTask = db.prepare(`
  INSERT INTO project_tasks (id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state)
  VALUES (@id, @projectId, @title, @status, @createdAt, @completedAt, @issueNumber, @issueUrl, @issueState)
`)

const listProjectTasks = db.prepare(`
  SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC
`)

const updateProjectTaskStatus = db.prepare(`
  UPDATE project_tasks
  SET status = @status, completed_at = @completedAt
  WHERE id = @id AND project_id = @projectId
`)

const getProjectTask = db.prepare(`SELECT * FROM project_tasks WHERE id = ? AND project_id = ?`)

const deleteProjectTask = db.prepare(`DELETE FROM project_tasks WHERE id = ? AND project_id = ?`)

// Issue-sync lookup: a task already mirroring a given (project, issue#).
const getProjectTaskByIssue = db.prepare(`SELECT * FROM project_tasks WHERE project_id = ? AND issue_number = ?`)

// Reconcile an existing task with its upstream issue. status/completed_at are
// decided by the caller (sync mapping); title and issue metadata always refresh.
const updateProjectTaskFromIssue = db.prepare(`
  UPDATE project_tasks
  SET title = @title, issue_url = @issueUrl, issue_state = @issueState,
      status = @status, completed_at = @completedAt
  WHERE id = @id
`)

export const projectTasksDb = {
  insertProjectTask,
  listProjectTasks,
  updateProjectTaskStatus,
  getProjectTask,
  deleteProjectTask,
  getProjectTaskByIssue,
  updateProjectTaskFromIssue,
}

// ─── WorkflowRun helpers ─────────────────────────────────────────────────────
// One supervised delegation-workflow run over a batch of selected todos.
// task_ids is stored as a JSON array string (bound JSON.stringify'd at the call
// site). run_id is null until the underlying agent run is created.

const insertWorkflowRun = db.prepare(`
  INSERT INTO workflow_runs (id, project_id, run_id, task_ids, mode, status, created_at, completed_at)
  VALUES (@id, @projectId, @runId, @taskIds, @mode, @status, @createdAt, @completedAt)
`)

const patchWorkflowRunId = db.prepare(`UPDATE workflow_runs SET run_id = ? WHERE id = ?`)

const updateWorkflowRunStatus = db.prepare(`
  UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?
`)

const getWorkflowRun = db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`)

const listWorkflowRunsByProject = db.prepare(`
  SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC
`)

export const workflowRunsDb = {
  insertWorkflowRun,
  patchWorkflowRunId,
  updateWorkflowRunStatus,
  getWorkflowRun,
  listWorkflowRunsByProject,
}

// ─── kstore: work-item helpers ───────────────────────────────────────────────
// Backs the kstore MCP work-item tools. Tickets are run-scoped (run_id), not
// project-scoped — work_items↔project_tasks unification is a Phase-5 follow-up.

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (id, run_id, title, body, status, created_at, updated_at)
  VALUES (@id, @runId, @title, @body, @status, @createdAt, @updatedAt)
`)
const updateWorkItem = db.prepare(`
  UPDATE work_items SET title = @title, body = @body, status = @status, updated_at = @updatedAt
  WHERE id = @id
`)
const getWorkItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`)
// Run-scoped fetch — `IS` is null-safe so a null owner (no/unknown run) only
// matches null-owner rows. The tools resolve ownership through this so one run
// can never read or mutate another run's tickets.
const getWorkItemOwned = db.prepare(`SELECT * FROM work_items WHERE id = ? AND run_id IS ?`)
const listWorkItemsByRun = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? ORDER BY created_at DESC LIMIT ?`,
)
const listWorkItemsByRunStatus = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
)

export const workItemsDb = {
  insertWorkItem,
  updateWorkItem,
  getWorkItem,
  getWorkItemOwned,
  listWorkItemsByRun,
  listWorkItemsByRunStatus,
}

// ─── kstore: agent-memory (lesson) helpers ───────────────────────────────────
// Backs lesson_propose / lesson_list. A proposed lesson lands 'pending'; the
// operator accepts/rejects out of band (memory layer A — no retrieval here).

const insertLesson = db.prepare(`
  INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at)
  VALUES (@id, @runId, @lesson, @status, @createdAt, @reviewedAt)
`)
const getLesson = db.prepare(`SELECT * FROM agent_memory WHERE id = ?`)
// Run-scoped lists (null-safe `IS`) so a run only sees the lessons it proposed.
const listLessonsByRun = db.prepare(
  `SELECT * FROM agent_memory WHERE run_id IS ? ORDER BY created_at DESC LIMIT ?`,
)
const listLessonsByRunStatus = db.prepare(
  `SELECT * FROM agent_memory WHERE run_id IS ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
)

export const agentMemoryDb = { insertLesson, getLesson, listLessonsByRun, listLessonsByRunStatus }

// ─── kstore: workflow-step (status-write) helpers ────────────────────────────
// Backs workflow_step_set / workflow_status_set. The MCP server resolves the
// workflow_runs row from the injected K_RUN_ID (run_id), so the agent never
// handles the workflowRunId itself.

const getWorkflowRunByRunId = db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`)
const getWorkflowStepByLabel = db.prepare(
  `SELECT * FROM workflow_steps WHERE workflow_run_id = ? AND label = ?`,
)
const listWorkflowSteps = db.prepare(
  `SELECT * FROM workflow_steps WHERE workflow_run_id = ? ORDER BY seq ASC, updated_at ASC`,
)
const nextWorkflowStepSeq = db.prepare(
  `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM workflow_steps WHERE workflow_run_id = ?`,
)
const upsertWorkflowStepRow = db.prepare(`
  INSERT INTO workflow_steps (id, workflow_run_id, seq, label, kind, work_item_id, status, detail, updated_at)
  VALUES (@id, @workflowRunId, @seq, @label, @kind, @workItemId, @status, @detail, @updatedAt)
  ON CONFLICT(workflow_run_id, label) DO UPDATE SET
    kind         = excluded.kind,
    work_item_id = excluded.work_item_id,
    status       = excluded.status,
    detail       = excluded.detail,
    updated_at   = excluded.updated_at
`)

// Upsert a step by (workflow_run_id, label) in one transaction: a new label gets
// the next seq; an existing label keeps its seq (only kind/status/detail/link
// refresh). Returns the resulting row.
const setWorkflowStep = db.transaction(
  (s: {
    id: string
    workflowRunId: string
    label: string
    kind: string
    workItemId: string | null
    status: string
    detail: string | null
    updatedAt: number
  }) => {
    const existing = getWorkflowStepByLabel.get(s.workflowRunId, s.label) as
      | { seq: number }
      | undefined
    const seq = existing
      ? existing.seq
      : (nextWorkflowStepSeq.get(s.workflowRunId) as { next: number }).next
    upsertWorkflowStepRow.run({ ...s, seq })
    return getWorkflowStepByLabel.get(s.workflowRunId, s.label)
  },
)

export const workflowStepsDb = {
  getWorkflowRunByRunId,
  getWorkflowStepByLabel,
  listWorkflowSteps,
  setWorkflowStep,
}

// ─── GitHub cache helpers ────────────────────────────────────────────────────

const upsertGithubCache = db.prepare(`
  INSERT INTO github_cache (project_id, kind, payload, fetched_at)
  VALUES (@projectId, @kind, @payload, @fetchedAt)
  ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`)

const getGithubCache = db.prepare(`SELECT * FROM github_cache WHERE project_id = ? AND kind = ?`)

export const githubDb = { upsertGithubCache, getGithubCache }

// ─── Skills helpers ──────────────────────────────────────────────────────────

const insertSkill = db.prepare(`
  INSERT INTO skills (id, name, description, type, source, triggerType, schedule, eventTrigger, enabled, createdAt)
  VALUES (@id, @name, @description, @type, @source, @triggerType, @schedule, @eventTrigger, @enabled, @createdAt)
`)

const listSkills = db.prepare(`SELECT * FROM skills ORDER BY createdAt DESC`)

const getSkill = db.prepare(`SELECT * FROM skills WHERE id = ?`)

const getSkillByName = db.prepare(`SELECT * FROM skills WHERE name = ?`)

const updateSkillEnabled = db.prepare(`UPDATE skills SET enabled = ? WHERE id = ?`)

const updateSkillSchedule = db.prepare(`UPDATE skills SET schedule = ?, eventTrigger = ? WHERE id = ?`)

// Editable content fields (name/description/source). Caller passes the current
// value for any field not being changed, mirroring updateSkillSchedule.
const updateSkillContent = db.prepare(
  `UPDATE skills SET name = @name, description = @description, source = @source WHERE id = @id`,
)

const deleteSkill = db.prepare(`DELETE FROM skills WHERE id = ?`)

const insertSkillRun = db.prepare(`
  INSERT INTO skill_runs (id, skillId, runId, triggeredBy, startedAt, completedAt, status)
  VALUES (@id, @skillId, @runId, @triggeredBy, @startedAt, @completedAt, @status)
`)

const listSkillRuns = db.prepare(`
  SELECT * FROM skill_runs WHERE skillId = ? ORDER BY startedAt DESC LIMIT 20
`)

const updateSkillRunStatus = db.prepare(`
  UPDATE skill_runs SET status = ?, completedAt = ? WHERE id = ?
`)

export const skillsDb = {
  insertSkill,
  listSkills,
  getSkill,
  getSkillByName,
  updateSkillEnabled,
  updateSkillSchedule,
  updateSkillContent,
  deleteSkill,
  insertSkillRun,
  listSkillRuns,
  updateSkillRunStatus,
}

// ─── Skill eval helpers ──────────────────────────────────────────────────────

const insertSkillEval = db.prepare(`
  INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
  VALUES (@id, @skillId, @runId, @status, @regression, @baselineEvalId, @createdAt, @completedAt)
`)

const getSkillEval = db.prepare(`SELECT * FROM skill_evals WHERE id = ?`)

const listSkillEvals = db.prepare(`
  SELECT * FROM skill_evals WHERE skillId = ? ORDER BY createdAt DESC LIMIT 20
`)

// Most recent completed (pass|fail) eval for a skill — the regression baseline.
const latestCompletedSkillEval = db.prepare(`
  SELECT * FROM skill_evals
  WHERE skillId = ? AND status IN ('pass','fail')
  ORDER BY createdAt DESC LIMIT 1
`)

const patchSkillEvalRunId = db.prepare(`UPDATE skill_evals SET runId = ? WHERE id = ?`)

const updateSkillEvalResult = db.prepare(`
  UPDATE skill_evals SET status = @status, regression = @regression, baselineEvalId = @baselineEvalId, completedAt = @completedAt WHERE id = @id
`)

export const skillEvalsDb = {
  insertSkillEval,
  getSkillEval,
  listSkillEvals,
  latestCompletedSkillEval,
  patchSkillEvalRunId,
  updateSkillEvalResult,
}

// ─── Runtime config helpers ──────────────────────────────────────────────────

const getConfigRow = db.prepare(`SELECT value FROM app_config WHERE key = ?`)
const upsertConfigRow = db.prepare(`
  INSERT INTO app_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`)

export const configDb = {
  get(key: string): string | undefined {
    const row = getConfigRow.get(key) as { value: string } | undefined
    return row?.value
  },
  set(key: string, value: string): void {
    upsertConfigRow.run(key, value)
  },
}
