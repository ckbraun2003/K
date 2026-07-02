import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import type { RunStatus, VerificationReport, ProjectTask, AgentProfile, NamedWorkflow, WorkflowRole } from '@k/shared'

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

  -- Operator-editable named workflow TEMPLATES (P5.3b). name is UNIQUE so the seed is
  -- idempotent by name. roles is a JSON array of {id,label,description}; prompt_scaffold
  -- carries the delegation-prompt template (with a {{CHECKLIST}} token); cross_project is
  -- a reserved flag (execution deferred). This is the DB entity distinct from the @k/shared
  -- WorkflowDefinition diagram type (D-047).
  CREATE TABLE IF NOT EXISTS workflow_definitions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    roles           TEXT NOT NULL DEFAULT '[]',
    prompt_scaffold TEXT NOT NULL,
    cross_project   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

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

  -- ── Eval subsystem (F3) ──────────────────────────────────────────────────────
  -- DB-backed model behind the ported T-EVAL harness (core/src/eval/*). GENERALIZES
  -- skill_evals: a registry of systems-under-eval (+ their cases), eval runs over a
  -- model×variant matrix, per-case results, and frozen baselines. Prompt/degraded/
  -- rubric are stored as FILE PATHS (registry-relative) — never the prompt text —
  -- and resolved against the repo root by loadSystemsFromDb (core/src/eval/store.ts).
  -- camelCase columns match the skills/skill_evals convention.
  CREATE TABLE IF NOT EXISTS eval_systems (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    job             TEXT,
    promptFile      TEXT NOT NULL,
    degradedFile    TEXT,
    rubricFile      TEXT,
    allowedTools    TEXT NOT NULL DEFAULT '[]',   -- JSON array
    disallowedTools TEXT NOT NULL DEFAULT '[]',   -- JSON array
    maxTurns        INTEGER NOT NULL DEFAULT 14,   -- matches the file loader default (seed writes explicit values)
    enabled         INTEGER NOT NULL DEFAULT 1,
    createdAt       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eval_cases (
    id              TEXT PRIMARY KEY,
    systemId        TEXT NOT NULL REFERENCES eval_systems(id) ON DELETE CASCADE,
    title           TEXT,
    input           TEXT NOT NULL,
    fixture         TEXT,
    checks          TEXT NOT NULL DEFAULT '[]',   -- JSON array of the CHECKS DSL
    allowedTools    TEXT,                          -- JSON array, nullable per-case override
    refusalExpected INTEGER,                       -- nullable 0/1
    judgeEnabled    INTEGER,                       -- nullable; 0 disables the judge
    maxTurns        INTEGER,
    timeoutMs       INTEGER,
    createdAt       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_eval_cases_system ON eval_cases(systemId);

  CREATE TABLE IF NOT EXISTS eval_runs (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','error','killed')),
    models        TEXT NOT NULL,                   -- JSON array
    variants      TEXT NOT NULL,                   -- JSON array
    systems       TEXT NOT NULL,                   -- JSON array of system ids
    dry           INTEGER NOT NULL DEFAULT 0,
    totalJobs     INTEGER NOT NULL DEFAULT 0,
    completedJobs INTEGER NOT NULL DEFAULT 0,
    totalCostUsd  REAL NOT NULL DEFAULT 0,
    report        TEXT,                            -- JSON when done
    error         TEXT,
    createdAt     INTEGER NOT NULL,
    completedAt   INTEGER
  );

  CREATE TABLE IF NOT EXISTS eval_results (
    id             TEXT PRIMARY KEY,
    evalRunId      TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    systemId       TEXT NOT NULL,
    caseId         TEXT NOT NULL,
    model          TEXT NOT NULL,
    variant        TEXT NOT NULL CHECK(variant IN ('real','degraded')),
    detPass        INTEGER,
    detScore       REAL,
    formatScore    REAL,
    judgeOverall   REAL,
    judgeVerdict   TEXT,
    refusalCorrect INTEGER,                        -- nullable
    costUsd        REAL,
    ms             INTEGER,
    numTurns       INTEGER,
    error          TEXT,
    raw            TEXT,                            -- JSON full record
    createdAt      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(evalRunId);

  CREATE TABLE IF NOT EXISTS eval_baselines (
    systemId  TEXT PRIMARY KEY REFERENCES eval_systems(id) ON DELETE CASCADE,
    metrics   TEXT NOT NULL,                       -- JSON (the frozen baseline file)
    evalRunId TEXT REFERENCES eval_runs(id) ON DELETE SET NULL,
    frozenAt  INTEGER NOT NULL
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

  -- ── logistics working store (P5.1a) ─────────────────────────────────────────
  -- K's secretary-tier logistics store: notes, calendar events, and reminders the
  -- secretary reaches through the logistics MCP server (calendar/notes/scheduling)
  -- — STORAGE, not execution. Run-scoped exactly like work_items: run_id is the
  -- managed run that created the row (resolved from K_RUN_ID); ON DELETE SET NULL
  -- keeps the row if its run is later removed. CREATE TABLE IF NOT EXISTS (fresh
  -- installs); these are NOT evolved via migrate().
  CREATE TABLE IF NOT EXISTS logistics_notes (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logistics_notes_run ON logistics_notes(run_id, created_at);

  CREATE TABLE IF NOT EXISTS logistics_events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    starts_at   INTEGER NOT NULL,
    ends_at     INTEGER,
    location    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logistics_events_run ON logistics_events(run_id, starts_at);

  CREATE TABLE IF NOT EXISTS logistics_reminders (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    text        TEXT NOT NULL,
    remind_at   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','done','cancelled')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logistics_reminders_run ON logistics_reminders(run_id, remind_at);

  -- ── management working store (Chief org — P5.2a) ────────────────────────────
  -- The Chief's management store: assignments (an objective handed to a lead) and
  -- reports (a status write up the chain). Management is STORAGE, not execution —
  -- persisting an assignment here does NOT dispatch the lead (autonomous delegation
  -- is P5.2b). Run-scoped exactly like logistics_*: run_id is the managed run that
  -- created the row (resolved from K_RUN_ID); ON DELETE SET NULL keeps the row if
  -- its run is later removed. projects is a JSON array (the scope_projects scope).
  -- A report's assignment_id is a nullable soft link (ON DELETE SET NULL) so a
  -- report survives its assignment. CREATE TABLE IF NOT EXISTS (fresh installs);
  -- these are NOT evolved via migrate().
  CREATE TABLE IF NOT EXISTS mgmt_assignments (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
    lead        TEXT NOT NULL,
    objective   TEXT NOT NULL,
    note        TEXT,
    workflow    TEXT,
    projects    TEXT NOT NULL DEFAULT '[]',   -- JSON array
    lead_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,   -- the dispatched lead's run (dispatch_lead); NULL until dispatched
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mgmt_assignments_run ON mgmt_assignments(run_id, created_at);

  CREATE TABLE IF NOT EXISTS mgmt_reports (
    id             TEXT PRIMARY KEY,
    run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
    assignment_id  TEXT REFERENCES mgmt_assignments(id) ON DELETE SET NULL,
    body           TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mgmt_reports_run ON mgmt_reports(run_id, created_at);

  -- ── K front door — durable threads (P5.1c, D-023) ───────────────────────────
  -- K's persistent identity: the durable conversation is the SOURCE OF TRUTH
  -- (survives reload), while execution is ephemeral. active_run_id is the warm
  -- interactive run K is chatting on (null when cold/idle); ON DELETE SET NULL so
  -- clearing a finished run keeps the thread. status is a display hint.
  -- CREATE TABLE IF NOT EXISTS (fresh installs); NOT evolved via migrate().
  CREATE TABLE IF NOT EXISTS k_threads (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
    active_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS k_thread_turns (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES k_threads(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK(role IN ('user','k')),
    text       TEXT NOT NULL,
    run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_k_thread_turns ON k_thread_turns(thread_id, created_at);

  -- ── Agent org (P5.0) ─────────────────────────────────────────────────────────
  -- Durable agent identities (bible section 03, D-020): one entity per row, gated by
  -- an authority tier (secretary|chief|orchestrator). charter is the charter-asset
  -- BASENAME the profile materializes (=== tier for the durable tiers) — the charter
  -- PROMPT itself lives in agent-config/tiers/<charter>.charter.md (single source,
  -- loaded by the synthesizer), never inlined here. allowed_tools/mcp_servers/skills
  -- are JSON arrays mirroring the tier's resolved authority (authority.ts) so a row
  -- is a durable, inspectable grant. name is UNIQUE so the seed is idempotent by name.
  CREATE TABLE IF NOT EXISTS agent_profiles (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    tier          TEXT NOT NULL CHECK(tier IN ('secretary','chief','orchestrator')),
    charter       TEXT NOT NULL CHECK(charter IN ('secretary','chief','orchestrator')),
    default_model TEXT NOT NULL,
    allowed_tools TEXT NOT NULL DEFAULT '[]',   -- JSON array
    mcp_servers   TEXT NOT NULL DEFAULT '[]',   -- JSON array
    skills        TEXT NOT NULL DEFAULT '[]',   -- JSON array
    created_at    INTEGER NOT NULL
  );

  -- One activation of a profile into a supervised run (startAgentRun). This is the
  -- tracking row the run-lifecycle seam patches (run_id) then finalizes (status),
  -- mirroring skill_runs/workflow_runs. run_id is null until the run is created;
  -- ON DELETE SET NULL keeps the activation record if its run is later removed.
  CREATE TABLE IF NOT EXISTS agent_runs (
    id           TEXT PRIMARY KEY,
    profile_id   TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
    trigger      TEXT NOT NULL
                   CHECK(trigger IN ('user-message','schedule','event','delegation')),
    goal         TEXT,
    project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
    workflow_id  TEXT,   -- loose ref (no FK on purpose): a planned WorkflowDefinition id, whose table doesn't exist yet

    status       TEXT NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','completed','failed')),
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_profile ON agent_runs(profile_id, created_at);
  -- Point-lookup index for the by-run_id reads (the Chief autonomous-wake self-wake
  -- guard fires on EVERY terminal run_update — a hot path — so run_id must be indexed).
  CREATE INDEX IF NOT EXISTS idx_agent_runs_run_id ON agent_runs(run_id);
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
    // coverage_pct (F4.W1): nullable measured line-coverage % at verify time,
    // powering the live coverage-trend signal. Appended via guarded ALTER (not in
    // CREATE TABLE) exactly like score_breakdown — migrate() runs at boot so fresh
    // installs and existing DBs both gain it.
    addColumn(d, 'verification_reports', 'coverage_pct', 'REAL')
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
  // agent_memory.profile_id (P5.0): links a gated lesson to the profile whose run
  // proposed it, so memory can grow into per-profile retrieval (layers B/C). The
  // pre-existing kstore agent_memory table only carried run_id (the source run);
  // profile_id is appended via guarded ALTER so existing DBs gain it. ADD COLUMN
  // with REFERENCES is legal under foreign_keys=ON (default NULL); agent_profiles is
  // created in the DDL above, so the referenced table exists before this runs. The
  // hasTable guard keeps migrate() safe against old-schema fixtures predating the table.
  if (hasTable(d, 'agent_memory')) {
    addColumn(d, 'agent_memory', 'profile_id', 'TEXT REFERENCES agent_profiles(id)')
    d.exec(`CREATE INDEX IF NOT EXISTS idx_agent_memory_profile ON agent_memory(profile_id, created_at)`)
  }
  // mgmt_assignments.lead_run_id (P5.4 autonomous loop): the Chief→lead parent→child
  // link — the dispatched lead's run id on the Chief's durable assignment (parent =
  // run_id). Appended via guarded ALTER so existing DBs gain it; fresh installs get it
  // from the DDL above. The decl MUST match the CREATE-TABLE column EXACTLY, incl.
  // `ON DELETE SET NULL` — otherwise a migrated DB defaults to NO ACTION and a
  // `DELETE FROM runs` (e.g. deleteProject) would hit an FK violation on a dispatched
  // assignment while a fresh install would null the link. ADD COLUMN with a REFERENCES
  // clause (incl. ON DELETE) is legal under foreign_keys=ON because the default is NULL.
  // hasTable guard keeps migrate() safe against old-schema fixtures.
  if (hasTable(d, 'mgmt_assignments')) {
    addColumn(d, 'mgmt_assignments', 'lead_run_id', 'TEXT REFERENCES runs(id) ON DELETE SET NULL')
  }
  // work_items.scope (P5.1d1, D-026): the personal|org|project discriminator the
  // unified-task-store collapse (P5.1d2) keys on. Appended via guarded ALTER (not
  // in CREATE TABLE) exactly like score_breakdown / project_tasks-issue — migrate()
  // runs at boot so fresh installs and existing DBs both gain it. DEFAULT 'personal'
  // backfills every existing ticket (personal == run-scoped, the only scope today;
  // org/project are reserved for the P5.1d2 collapse). The hasTable guard keeps
  // migrate() safe against old-schema fixtures predating the table (db-migration.test.ts).
  if (hasTable(d, 'work_items')) {
    addColumn(d, 'work_items', 'scope', "TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','org','project'))")
  }
  // work_items project columns (P5.1d2, D-026/D-048): fold the deprecated
  // project_tasks store into the unified work_items store. project_id + the issue-
  // sync metadata (completed_at/issue_number/issue_url/issue_state) let a
  // scope='project' ticket carry everything a project_tasks row used to. Appended
  // via guarded ALTER (not in CREATE TABLE) exactly like `scope` — migrate() runs at
  // boot so fresh installs and existing DBs both gain them. project_id is a PLAIN FK
  // with NO ON DELETE action (matching the runs.project_id precedent; project-scoped
  // rows are cleaned explicitly in deleteProject) — ADD COLUMN with REFERENCES is
  // legal under foreign_keys=ON (default NULL). The hasTable guard keeps migrate()
  // safe against old-schema fixtures predating the table.
  if (hasTable(d, 'work_items')) {
    addColumn(d, 'work_items', 'project_id', 'TEXT REFERENCES projects(id)')
    addColumn(d, 'work_items', 'completed_at', 'INTEGER')
    addColumn(d, 'work_items', 'issue_number', 'INTEGER')
    addColumn(d, 'work_items', 'issue_url', 'TEXT')
    addColumn(d, 'work_items', 'issue_state', 'TEXT')
    d.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, created_at)`)
    d.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_issue ON work_items(project_id, issue_number)`)
  }
  // project_tasks → work_items backfill (P5.1d2, D-026). Idempotent (NOT EXISTS keys
  // on the reused project_task id === work_item id), so a re-boot never duplicates.
  // Runs AFTER the work_items project columns above exist and AFTER the project_tasks
  // issue-columns ALTER earlier in migrate(), so every SELECT column is present.
  // COPY only — project_tasks rows are left in place as a frozen safety copy (the
  // table is deprecated and dropped in d2b). project_tasks.status values
  // (open/in_progress/done) all satisfy the work_items status CHECK. run_id is NULL
  // (these are project-scoped, not run-scoped); scope is stamped 'project'.
  if (hasTable(d, 'work_items') && hasTable(d, 'project_tasks')) {
    d.exec(`
      INSERT INTO work_items (id, run_id, project_id, title, body, status, scope, created_at, updated_at, completed_at, issue_number, issue_url, issue_state)
      SELECT pt.id, NULL, pt.project_id, pt.title, NULL, pt.status, 'project', pt.created_at, pt.created_at, pt.completed_at, pt.issue_number, pt.issue_url, pt.issue_state
      FROM project_tasks pt
      WHERE NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id = pt.id)
    `)
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

// Delegate-relevant events for a run: every `delegate` tool_use event PLUS its paired
// tool_result (they share a tool_use_id). This is the exact, naturally-bounded slice
// the Chief org delegation tree needs — a run's sub-agents ARE its delegate calls
// (D-016) — so it never materializes/truncates the full event log (a long lead run can
// hold thousands of events; an arbitrary earliest-N cap would drop late delegates and
// orphan pairs). Pairing still happens web-side (eventsToWorkflowTree).
const listDelegateEvents = db.prepare(`
  SELECT * FROM events
  WHERE run_id = @runId
    AND tool_use_id IN (
      SELECT tool_use_id FROM events
      WHERE run_id = @runId AND tool_kind = 'delegate' AND tool_use_id IS NOT NULL
    )
  ORDER BY seq ASC
`)

// Fetch the raw JSON line for a single event — used by the lazy per-event endpoint.
const getEventRaw = db.prepare(`SELECT raw FROM events WHERE run_id = ? AND seq = ?`)

export const eventsDb = { insertEvent, listEvents, listDelegateEvents, getEventRaw }

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
// Project-scoped work_items (the collapsed project_tasks store, P5.1d2): project_id
// is a NO-ACTION FK (no ON DELETE cascade), so these rows must be removed before the
// project row or the delete throws a FK violation. Personal items (project_id NULL,
// the run-scoped kstore tickets) are untouched.
const deleteProjectWorkItems = db.prepare(`DELETE FROM work_items WHERE project_id = ?`)
const deleteProjectRow = db.prepare(`DELETE FROM projects WHERE id = ?`)
const deleteProject = db.transaction((id: string) => {
  deleteProjectRunEvents.run(id)
  deleteProjectRuns.run(id)
  deleteProjectReports.run(id)
  deleteProjectGithubCache.run(id)
  deleteProjectWorkItems.run(id) // project-scoped work_items: NO-ACTION FK, delete before the project row
  deleteProjectRow.run(id) // cascades the (deprecated, frozen) project_tasks, workflow_runs, project_graphs
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
  INSERT INTO verification_reports (id, project_id, score, findings, fixes_applied, started_at, completed_at, score_breakdown, coverage_pct)
  VALUES (@id, @projectId, @score, @findings, @fixesApplied, @startedAt, @completedAt, @scoreBreakdown, @coveragePct)
`)

const listVerificationReports = db.prepare(`
  SELECT * FROM verification_reports WHERE project_id = ? ORDER BY started_at DESC LIMIT 20
`)

// Newest report for a project — runVerification reads its persisted coverage_pct
// to compute the live coverage trend against real history.
const latestVerificationReport = db.prepare(`
  SELECT * FROM verification_reports WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
`)

export const verificationDb = { insertVerificationReport, listVerificationReports, latestVerificationReport }

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
  if (r.coverage_pct != null) report.coveragePct = Number(r.coverage_pct)
  return report
}

// ─── ProjectTask helpers ─────────────────────────────────────────────────────
// COLLAPSED (P5.1d2, D-026): these helpers now operate on the unified `work_items`
// store with scope='project' instead of the deprecated (frozen) `project_tasks`
// table. Param names/positions are UNCHANGED so every caller (routes/projects.ts,
// github.ts, workflows.ts) and the characterization tests bind the same objects;
// each SELECT projects the EXACT old snake_case column set so rowToProjectTask and
// tests reading t.issue_number / t.completed_at keep working. run_id is stamped NULL
// (project-scoped, not run-scoped) and updated_at reuses created_at on insert (the
// old project_tasks store had no updated_at). better-sqlite3 binds named params
// strictly, so each statement references exactly the params its callers pass.

const insertProjectTask = db.prepare(`
  INSERT INTO work_items (id, run_id, project_id, title, body, status, scope, created_at, updated_at, completed_at, issue_number, issue_url, issue_state)
  VALUES (@id, NULL, @projectId, @title, NULL, @status, 'project', @createdAt, @createdAt, @completedAt, @issueNumber, @issueUrl, @issueState)
`)

const listProjectTasks = db.prepare(`
  SELECT id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state
  FROM work_items WHERE project_id = ? AND scope = 'project' ORDER BY created_at DESC
`)

const updateProjectTaskStatus = db.prepare(`
  UPDATE work_items
  SET status = @status, completed_at = @completedAt
  WHERE id = @id AND project_id = @projectId AND scope = 'project'
`)

const getProjectTask = db.prepare(`
  SELECT id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state
  FROM work_items WHERE id = ? AND project_id = ? AND scope = 'project'
`)

const deleteProjectTask = db.prepare(`DELETE FROM work_items WHERE id = ? AND project_id = ? AND scope = 'project'`)

// Issue-sync lookup: a task already mirroring a given (project, issue#).
const getProjectTaskByIssue = db.prepare(`
  SELECT id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state
  FROM work_items WHERE project_id = ? AND issue_number = ? AND scope = 'project'
`)

// Reconcile an existing task with its upstream issue. status/completed_at are
// decided by the caller (sync mapping); title and issue metadata always refresh.
const updateProjectTaskFromIssue = db.prepare(`
  UPDATE work_items
  SET title = @title, issue_url = @issueUrl, issue_state = @issueState,
      status = @status, completed_at = @completedAt
  WHERE id = @id AND scope = 'project'
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

/** Map a project_tasks DB row → the shared ProjectTask shape (snake_case →
 *  camelCase, values coerced to their typed forms; nullable cols → null). The
 *  single source for this mapping — previously copy-pasted in workflows.ts (typed,
 *  internal) and routes/projects.ts (untyped, HTTP). For a well-formed row the
 *  coercion is JSON-identical to the old raw route mapper (sqlite already returns
 *  TEXT→string / INTEGER→number), so the HTTP response shape is unchanged. */
export function rowToProjectTask(r: Record<string, unknown>): ProjectTask {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    status: r.status as ProjectTask['status'],
    createdAt: Number(r.created_at),
    completedAt: r.completed_at != null ? Number(r.completed_at) : null,
    issueNumber: r.issue_number != null ? Number(r.issue_number) : null,
    issueUrl: r.issue_url != null ? String(r.issue_url) : null,
    issueState: r.issue_state != null ? String(r.issue_state) : null,
  }
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
// Backs the kstore MCP work-item tools — the run-scoped (run_id) PERSONAL/ORG
// tickets. project-scoped tickets now live in this SAME table (scope='project',
// P5.1d2, the project_tasks fold below). The run-scoped fetch/list statements
// therefore ALSO guard `scope != 'project'`: `run_id IS ?` alone is null-safe but a
// null owner (K_RUN_ID unset / missing run row / start-of-run race) would otherwise
// match the backfilled project rows (run_id NULL) and let kstore read/mutate a
// project task — so the scope guard keeps the project surface isolated from kstore.

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (id, run_id, title, body, status, scope, created_at, updated_at)
  VALUES (@id, @runId, @title, @body, @status, @scope, @createdAt, @updatedAt)
`)
const updateWorkItem = db.prepare(`
  UPDATE work_items SET title = @title, body = @body, status = @status, updated_at = @updatedAt
  WHERE id = @id
`)
const getWorkItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`)
// Run-scoped fetch — `IS` is null-safe so a null owner (no/unknown run) only
// matches null-owner rows. The tools resolve ownership through this so one run
// can never read or mutate another run's tickets.
const getWorkItemOwned = db.prepare(`SELECT * FROM work_items WHERE id = ? AND run_id IS ? AND scope != 'project'`)
const listWorkItemsByRun = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? AND scope != 'project' ORDER BY created_at DESC LIMIT ?`,
)
const listWorkItemsByRunStatus = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? AND scope != 'project' AND status = ? ORDER BY created_at DESC LIMIT ?`,
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
// Operator-gate lists (P5.1b): fleet-wide (not run-scoped) by status, joined to the
// proposing profile's name so the review surface shows who proposed each lesson. The
// join is LEFT so an unassigned (profile_id NULL) lesson still lists. profile_id exists
// because migrate(db) (which ALTERs it in) runs before these statements are prepared.
const listLessonsByStatusJoined = db.prepare(
  `SELECT m.*, p.name AS profile_name FROM agent_memory m
     LEFT JOIN agent_profiles p ON m.profile_id = p.id
   WHERE m.status = ? ORDER BY m.created_at DESC LIMIT ?`,
)
const listLessonsByStatusProfileJoined = db.prepare(
  `SELECT m.*, p.name AS profile_name FROM agent_memory m
     LEFT JOIN agent_profiles p ON m.profile_id = p.id
   WHERE m.status = ? AND m.profile_id = ? ORDER BY m.created_at DESC LIMIT ?`,
)
// Flip a lesson's status in place (pending→accepted|rejected) and stamp reviewed_at.
// This mutates the SAME row insertLesson wrote (the SEAMS contract with the producer).
const updateLessonStatus = db.prepare(
  `UPDATE agent_memory SET status = @status, reviewed_at = @reviewedAt WHERE id = @id`,
)

export const agentMemoryDb = {
  insertLesson,
  getLesson,
  listLessonsByRun,
  listLessonsByRunStatus,
  listLessonsByStatusJoined,
  listLessonsByStatusProfileJoined,
  updateLessonStatus,
}

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

// ─── logistics working store helpers (P5.1a) ─────────────────────────────────
// Backs the logistics MCP tools (notes / calendar events / reminders). Every row
// is run-scoped like work_items — the null-safe `IS` operator means a null owner
// (no/unknown run) only matches null-owner rows, so one run can never read or
// mutate another run's logistics rows. The calendar-event statement CONSTS are
// `logistics*`-prefixed to avoid colliding with the agent-events helpers
// (module-scope insertEvent / getEventRaw / listEvents); they are exposed under
// clean keys on the `logisticsDb` object below.

// notes
const insertNote = db.prepare(`
  INSERT INTO logistics_notes (id, run_id, body, done, created_at, updated_at)
  VALUES (@id, @runId, @body, @done, @createdAt, @updatedAt)
`)
const updateNote = db.prepare(`
  UPDATE logistics_notes SET body = @body, done = @done, updated_at = @updatedAt WHERE id = @id
`)
const getNote = db.prepare(`SELECT * FROM logistics_notes WHERE id = ?`)
const getNoteOwned = db.prepare(`SELECT * FROM logistics_notes WHERE id = ? AND run_id IS ?`)
const listNotesByRun = db.prepare(
  `SELECT * FROM logistics_notes WHERE run_id IS ? ORDER BY created_at DESC LIMIT ?`,
)
const listNotesByRunDone = db.prepare(
  `SELECT * FROM logistics_notes WHERE run_id IS ? AND done = ? ORDER BY created_at DESC LIMIT ?`,
)

// calendar events (consts prefixed to avoid the agent-events insertEvent/listEvents)
const insertLogisticsEvent = db.prepare(`
  INSERT INTO logistics_events (id, run_id, title, starts_at, ends_at, location, created_at, updated_at)
  VALUES (@id, @runId, @title, @startsAt, @endsAt, @location, @createdAt, @updatedAt)
`)
const updateLogisticsEvent = db.prepare(`
  UPDATE logistics_events SET title = @title, starts_at = @startsAt, ends_at = @endsAt,
    location = @location, updated_at = @updatedAt WHERE id = @id
`)
const getLogisticsEvent = db.prepare(`SELECT * FROM logistics_events WHERE id = ?`)
const getLogisticsEventOwned = db.prepare(`SELECT * FROM logistics_events WHERE id = ? AND run_id IS ?`)
// The from/to window is pushed INTO SQL (not filtered in JS after a LIMIT) so the
// LIMIT caps the WINDOWED set — a caller passing `from` can never silently miss an
// in-window event that sorts after `limit` earlier out-of-window rows.
const listLogisticsEventsByRun = db.prepare(
  `SELECT * FROM logistics_events WHERE run_id IS ? AND starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC LIMIT ?`,
)

// reminders
const insertReminder = db.prepare(`
  INSERT INTO logistics_reminders (id, run_id, text, remind_at, status, created_at, updated_at)
  VALUES (@id, @runId, @text, @remindAt, @status, @createdAt, @updatedAt)
`)
const updateReminder = db.prepare(`
  UPDATE logistics_reminders SET status = @status, updated_at = @updatedAt WHERE id = @id
`)
const getReminder = db.prepare(`SELECT * FROM logistics_reminders WHERE id = ?`)
const getReminderOwned = db.prepare(`SELECT * FROM logistics_reminders WHERE id = ? AND run_id IS ?`)
const listRemindersByRun = db.prepare(
  `SELECT * FROM logistics_reminders WHERE run_id IS ? ORDER BY remind_at ASC LIMIT ?`,
)
const listRemindersByRunStatus = db.prepare(
  `SELECT * FROM logistics_reminders WHERE run_id IS ? AND status = ? ORDER BY remind_at ASC LIMIT ?`,
)

export const logisticsDb = {
  // notes
  insertNote,
  updateNote,
  getNote,
  getNoteOwned,
  listNotesByRun,
  listNotesByRunDone,
  // calendar events
  insertEvent: insertLogisticsEvent,
  updateEvent: updateLogisticsEvent,
  getEvent: getLogisticsEvent,
  getEventOwned: getLogisticsEventOwned,
  listEventsByRun: listLogisticsEventsByRun,
  // reminders
  insertReminder,
  updateReminder,
  getReminder,
  getReminderOwned,
  listRemindersByRun,
  listRemindersByRunStatus,
}

// ─── management working store helpers (Chief org — P5.2a) ────────────────────
// Backs the mgmt MCP tools (assignments / reports). Writes + ownership reads are
// run-scoped like logistics — the null-safe `IS` operator means a null owner (no/
// unknown run) only matches null-owner rows, so one run can never read or mutate
// another run's assignments. `listRecentAssignments` is the ONE deliberately
// cross-run operator read: it feeds the Chief org-status Objectives panel (not a
// tool), so it is NOT run-scoped.

const insertAssignment = db.prepare(`
  INSERT INTO mgmt_assignments (id, run_id, lead, objective, note, workflow, projects, created_at, updated_at)
  VALUES (@id, @runId, @lead, @objective, @note, @workflow, @projects, @createdAt, @updatedAt)
`)
const updateAssignment = db.prepare(`
  UPDATE mgmt_assignments SET lead = @lead, objective = @objective, note = @note,
    workflow = @workflow, projects = @projects, updated_at = @updatedAt WHERE id = @id
`)
// Record the Chief→lead parent→child link (dispatch_lead): the dispatched lead's run
// id on the Chief's durable assignment. Distinct from updateAssignment so a dispatch
// only touches lead_run_id (+ updated_at), never the stored lead/objective/workflow.
const setAssignmentLeadRun = db.prepare(
  `UPDATE mgmt_assignments SET lead_run_id = @leadRunId, updated_at = @updatedAt WHERE id = @id`,
)
const getAssignment = db.prepare(`SELECT * FROM mgmt_assignments WHERE id = ?`)
const getAssignmentOwned = db.prepare(`SELECT * FROM mgmt_assignments WHERE id = ? AND run_id IS ?`)
// Cross-run operator read (Chief org Objectives panel) — NOT run-scoped by design.
const listRecentAssignments = db.prepare(
  `SELECT * FROM mgmt_assignments ORDER BY created_at DESC LIMIT ?`,
)

const insertReport = db.prepare(`
  INSERT INTO mgmt_reports (id, run_id, assignment_id, body, created_at)
  VALUES (@id, @runId, @assignmentId, @body, @createdAt)
`)
const getReport = db.prepare(`SELECT * FROM mgmt_reports WHERE id = ?`)
// Reports a given run filed, newest-first (bounded). Powers the K→Chief report-back
// (k-thread.ts): when a delegated Chief run reaches terminal, K surfaces the Chief's
// latest status report up onto its own thread. A read-only helper — the report row is
// still written only by the mgmt `report` tool (no new write path, no schema change).
const listReportsByRun = db.prepare(
  // id DESC is a deterministic tie-break so two reports written in the same ms have a
  // stable "latest" (the report-back reads LIMIT 1 as the Chief's latest status).
  `SELECT * FROM mgmt_reports WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
)
export const mgmtDb = {
  insertAssignment,
  updateAssignment,
  setAssignmentLeadRun,
  getAssignment,
  getAssignmentOwned,
  listRecentAssignments,
  insertReport,
  getReport,
  listReportsByRun,
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

// ─── Eval subsystem helpers (F3) ─────────────────────────────────────────────
// DB-backed model behind the ported T-EVAL harness (generalizes skill_evals).
// store.ts seeds these from testing/eval/* and loadSystemsFromDb() reads them
// back into the same shape loadSystems() returns. These statements are bound to
// the module `db` singleton; store.ts prepares its own statements on whatever
// connection it is handed so it can also drive an isolated (injected) DB.

const upsertEvalSystem = db.prepare(`
  INSERT INTO eval_systems (id, title, job, promptFile, degradedFile, rubricFile, allowedTools, disallowedTools, maxTurns, enabled, createdAt)
  VALUES (@id, @title, @job, @promptFile, @degradedFile, @rubricFile, @allowedTools, @disallowedTools, @maxTurns, @enabled, @createdAt)
  ON CONFLICT(id) DO UPDATE SET
    title           = excluded.title,
    job             = excluded.job,
    promptFile      = excluded.promptFile,
    degradedFile    = excluded.degradedFile,
    rubricFile      = excluded.rubricFile,
    allowedTools    = excluded.allowedTools,
    disallowedTools = excluded.disallowedTools,
    maxTurns        = excluded.maxTurns,
    enabled         = excluded.enabled
`)
const getEvalSystem = db.prepare(`SELECT * FROM eval_systems WHERE id = ?`)
const listEvalSystems = db.prepare(`SELECT * FROM eval_systems ORDER BY id`)
// Reserved for P5 eval management (operator delete of a system removed from the registry — also the
// clean fix for the seed-orphan-persist posture). No production caller yet — intentional scaffolding.
const deleteEvalSystem = db.prepare(`DELETE FROM eval_systems WHERE id = ?`)

export const evalSystemsDb = { upsertEvalSystem, getEvalSystem, listEvalSystems, deleteEvalSystem }

const insertEvalCase = db.prepare(`
  INSERT INTO eval_cases (id, systemId, title, input, fixture, checks, allowedTools, refusalExpected, judgeEnabled, maxTurns, timeoutMs, createdAt)
  VALUES (@id, @systemId, @title, @input, @fixture, @checks, @allowedTools, @refusalExpected, @judgeEnabled, @maxTurns, @timeoutMs, @createdAt)
  ON CONFLICT(id) DO UPDATE SET
    systemId        = excluded.systemId,
    title           = excluded.title,
    input           = excluded.input,
    fixture         = excluded.fixture,
    checks          = excluded.checks,
    allowedTools    = excluded.allowedTools,
    refusalExpected = excluded.refusalExpected,
    judgeEnabled    = excluded.judgeEnabled,
    maxTurns        = excluded.maxTurns,
    timeoutMs       = excluded.timeoutMs
`)
const deleteEvalCasesBySystem = db.prepare(`DELETE FROM eval_cases WHERE systemId = ?`)
const listEvalCasesBySystem = db.prepare(`SELECT * FROM eval_cases WHERE systemId = ? ORDER BY id`)

export const evalCasesDb = { insertEvalCase, deleteEvalCasesBySystem, listEvalCasesBySystem }

const insertEvalRun = db.prepare(`
  INSERT INTO eval_runs (id, status, models, variants, systems, dry, totalJobs, completedJobs, totalCostUsd, report, error, createdAt, completedAt)
  VALUES (@id, @status, @models, @variants, @systems, @dry, @totalJobs, @completedJobs, @totalCostUsd, @report, @error, @createdAt, @completedAt)
`)
const getEvalRun = db.prepare(`SELECT * FROM eval_runs WHERE id = ?`)
const listEvalRuns = db.prepare(`SELECT * FROM eval_runs ORDER BY createdAt DESC LIMIT ?`)
const updateEvalRunProgress = db.prepare(`
  UPDATE eval_runs SET completedJobs = @completedJobs, totalCostUsd = @totalCostUsd WHERE id = @id
`)
const updateEvalRunStatus = db.prepare(`
  UPDATE eval_runs SET status = @status, report = @report, error = @error, completedAt = @completedAt WHERE id = @id
`)
const deleteEvalRun = db.prepare(`DELETE FROM eval_runs WHERE id = ?`)

export const evalRunsDb = {
  insertEvalRun,
  getEvalRun,
  listEvalRuns,
  updateEvalRunProgress,
  updateEvalRunStatus,
  deleteEvalRun,
}

const insertEvalResult = db.prepare(`
  INSERT INTO eval_results (id, evalRunId, systemId, caseId, model, variant, detPass, detScore, formatScore, judgeOverall, judgeVerdict, refusalCorrect, costUsd, ms, numTurns, error, raw, createdAt)
  VALUES (@id, @evalRunId, @systemId, @caseId, @model, @variant, @detPass, @detScore, @formatScore, @judgeOverall, @judgeVerdict, @refusalCorrect, @costUsd, @ms, @numTurns, @error, @raw, @createdAt)
`)
const listEvalResultsByRun = db.prepare(`SELECT * FROM eval_results WHERE evalRunId = ? ORDER BY createdAt ASC`)

export const evalResultsDb = { insertEvalResult, listEvalResultsByRun }

const upsertEvalBaseline = db.prepare(`
  INSERT INTO eval_baselines (systemId, metrics, evalRunId, frozenAt)
  VALUES (@systemId, @metrics, @evalRunId, @frozenAt)
  ON CONFLICT(systemId) DO UPDATE SET
    metrics   = excluded.metrics,
    evalRunId = excluded.evalRunId,
    frozenAt  = excluded.frozenAt
`)
const getEvalBaseline = db.prepare(`SELECT * FROM eval_baselines WHERE systemId = ?`)
// Reserved for P5 (a baselines-overview endpoint). No production caller yet — intentional scaffolding.
const listEvalBaselines = db.prepare(`SELECT * FROM eval_baselines ORDER BY systemId`)

export const evalBaselinesDb = { upsertEvalBaseline, getEvalBaseline, listEvalBaselines }

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

// ─── Agent-profile helpers (P5.0) ────────────────────────────────────────────
// The durable agent-org registry. JSON columns (allowed_tools/mcp_servers/skills)
// are bound already-stringified at the call site (profiles.ts), mirroring the
// eval_systems convention. `name` is UNIQUE so the seed is idempotent by name.

const insertProfile = db.prepare(`
  INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
  VALUES (@id, @name, @tier, @charter, @defaultModel, @allowedTools, @mcpServers, @skills, @createdAt)
`)
const getProfileRow = db.prepare(`SELECT * FROM agent_profiles WHERE id = ?`)
const getProfileByNameRow = db.prepare(`SELECT * FROM agent_profiles WHERE name = ?`)
const listProfileRows = db.prepare(`SELECT * FROM agent_profiles ORDER BY created_at ASC`)
const updateProfileRow = db.prepare(`
  UPDATE agent_profiles
  SET name = @name, tier = @tier, charter = @charter, default_model = @defaultModel,
      allowed_tools = @allowedTools, mcp_servers = @mcpServers, skills = @skills
  WHERE id = @id
`)

export const agentProfilesDb = {
  insertProfile,
  getProfileRow,
  getProfileByNameRow,
  listProfileRows,
  updateProfileRow,
}

/** Map an agent_profiles DB row → the canonical AgentProfile shape (@k/shared).
 *  snake→camel; the `charter` column feeds the type's `charter` (charter-asset
 *  basename); the JSON columns parse to string[] (null-safe: garbled/absent JSON
 *  degrades to [] rather than throwing, mirroring rowToReport). */
export function rowToAgentProfile(r: Record<string, unknown>): AgentProfile {
  const parseStrArr = (v: unknown): string[] => {
    try {
      const p = JSON.parse(String(v ?? '[]'))
      return Array.isArray(p) ? p.map(String) : []
    } catch {
      return []
    }
  }
  return {
    id: String(r.id),
    name: String(r.name),
    tier: r.tier as AgentProfile['tier'],
    charter: r.charter as AgentProfile['charter'],
    defaultModel: String(r.default_model),
    allowedTools: parseStrArr(r.allowed_tools),
    mcpServers: parseStrArr(r.mcp_servers),
    skills: parseStrArr(r.skills),
  }
}

// ─── Agent-run helpers (P5.0) ────────────────────────────────────────────────
// The startAgentRun tracking rows — patched with the run id, then finalized on
// terminal, via the run-lifecycle seam (mirrors skill_runs / workflow_runs).

const insertAgentRun = db.prepare(`
  INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, project_id, workflow_id, status, created_at, completed_at)
  VALUES (@id, @profileId, @runId, @trigger, @goal, @projectId, @workflowId, @status, @createdAt, @completedAt)
`)
const patchAgentRunId = db.prepare(`UPDATE agent_runs SET run_id = ? WHERE id = ?`)
const updateAgentRunStatus = db.prepare(`UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ?`)
const getAgentRun = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`)
const listAgentRunsByProfile = db.prepare(
  `SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY created_at DESC`,
)
// Bounded newest-first variant — the Chief org route scans a lead's / the Chief's
// recent activations without materializing the whole history.
const listRecentAgentRunsByProfile = db.prepare(
  `SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?`,
)
// Chief autonomous wake (P5.2b, D-044) — the two guards' single-row reads (no table).
// Guard B: is a profile already mid-activation? (one Chief run at a time.)
const getRunningAgentRunByProfile = db.prepare(
  `SELECT id FROM agent_runs WHERE profile_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
)
// Self-wake guard: which profile owns the activation that produced this run_id?
const getAgentRunProfileByRunId = db.prepare(
  `SELECT profile_id FROM agent_runs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
)

export const agentRunsDb = {
  insertAgentRun,
  patchAgentRunId,
  updateAgentRunStatus,
  getAgentRun,
  listAgentRunsByProfile,
  listRecentAgentRunsByProfile,
  getRunningAgentRunByProfile,
  getAgentRunProfileByRunId,
}

// ─── Named-workflow helpers (P5.3b) ──────────────────────────────────────────
// The operator-editable workflow-template registry. JSON columns (roles) and the
// prompt_scaffold are bound already-stringified at the call site (workflow-defs.ts),
// mirroring the agent_profiles convention. `name` is UNIQUE so the seed is idempotent
// by name. This is the DB entity distinct from the @k/shared WorkflowDefinition diagram.

const insertWorkflowDef = db.prepare(`
  INSERT INTO workflow_definitions (id, name, roles, prompt_scaffold, cross_project, created_at)
  VALUES (@id, @name, @roles, @promptScaffold, @crossProject, @createdAt)
`)
const getWorkflowDefRow = db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`)
const getWorkflowDefByNameRow = db.prepare(`SELECT * FROM workflow_definitions WHERE name = ?`)
const listWorkflowDefRows = db.prepare(`SELECT * FROM workflow_definitions ORDER BY created_at ASC`)
const updateWorkflowDefRow = db.prepare(`
  UPDATE workflow_definitions
  SET name = @name, roles = @roles, prompt_scaffold = @promptScaffold, cross_project = @crossProject
  WHERE id = @id
`)

export const workflowDefsDb = {
  insertWorkflowDef,
  getWorkflowDefRow,
  getWorkflowDefByNameRow,
  listWorkflowDefRows,
  updateWorkflowDefRow,
}

/** Map a workflow_definitions DB row → the canonical NamedWorkflow shape (@k/shared).
 *  snake→camel; `roles` parses to WorkflowRole[] (null-safe: garbled/absent JSON degrades
 *  to [] rather than throwing, mirroring rowToAgentProfile); `cross_project` int→bool. */
export function rowToNamedWorkflow(r: Record<string, unknown>): NamedWorkflow {
  let roles: WorkflowRole[] = []
  try {
    const p = JSON.parse(String(r.roles ?? '[]'))
    if (Array.isArray(p)) roles = p as WorkflowRole[]
  } catch {
    roles = []
  }
  return {
    id: String(r.id),
    name: String(r.name),
    roles,
    promptScaffold: String(r.prompt_scaffold),
    crossProject: r.cross_project === 1 || Number(r.cross_project) === 1,
    createdAt: Number(r.created_at),
  }
}

// ─── K front-door threads (P5.1c, D-023) ─────────────────────────────────────
// The durable K conversation (persistent identity) + its turns. `active_run_id`
// tracks the warm interactive run; it's nulled when that run reaches terminal.

const insertThread = db.prepare(`
  INSERT INTO k_threads (id, title, status, active_run_id, created_at, updated_at)
  VALUES (@id, @title, @status, @activeRunId, @createdAt, @updatedAt)
`)
const getThread = db.prepare(`SELECT * FROM k_threads WHERE id = ?`)
const updateThreadActiveRun = db.prepare(`UPDATE k_threads SET active_run_id = ?, updated_at = ? WHERE id = ?`)
const updateThreadStatus = db.prepare(`UPDATE k_threads SET status = ?, updated_at = ? WHERE id = ?`)

const insertTurn = db.prepare(`
  INSERT INTO k_thread_turns (id, thread_id, role, text, run_id, created_at)
  VALUES (@id, @threadId, @role, @text, @runId, @createdAt)
`)
const getTurn = db.prepare(`SELECT * FROM k_thread_turns WHERE id = ?`)
const patchTurnRunId = db.prepare(`UPDATE k_thread_turns SET run_id = ? WHERE id = ?`)
const listTurns = db.prepare(`SELECT * FROM k_thread_turns WHERE thread_id = ? ORDER BY created_at ASC, id ASC`)

export const kThreadsDb = {
  insertThread,
  getThread,
  updateThreadActiveRun,
  updateThreadStatus,
  insertTurn,
  getTurn,
  patchTurnRunId,
  listTurns,
}
