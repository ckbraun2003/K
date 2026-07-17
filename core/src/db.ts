import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import type { RunStatus, VerificationReport, ProjectTask, AgentProfile, NamedWorkflow, WorkflowRole, SubAgentDef, PipelineLedgerEntry } from '@k/shared'
// authority.ts reads only fs + @k/shared types — no import cycle back into db.ts.
import { resolveAuthority } from './authority.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Exported so boot code (index.ts single-instance lock) resolves the SAME data dir
// as the DB + auth token, from one source of truth.
export const DATA_DIR = process.env.K_DATA_DIR ?? path.join(__dirname, '../../data')

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
    -- The Claude CLI session id parsed from the run's stream-json init line
    -- (SCHEMA_VERSION 8, P0 — E-22 groundwork). NULL until the init line is seen
    -- (and always NULL for ollama runs); lets a follow-up run \`--resume\` this
    -- run's session. Appended via guarded ALTER for migrated DBs (migrateSlow).
    cli_session_id TEXT,
    -- P2 (SCHEMA_VERSION 10): review-acknowledged timestamp (E-05). NULL = unreviewed
    -- (belongs in the Inbox); stamped once via approve / request-changes / inbox-dismiss.
    reviewed_at INTEGER,
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
    md          TEXT NOT NULL,
    -- Optional absolute path to a pre-composed on-disk .html to serve verbatim
    -- (e.g. a REGISTERED project's own <localPath>/artifacts/project-bible.html).
    -- When NULL, getArtifact falls back to ARTIFACTS_DIR/<slug>.html then md-render.
    -- Keeps a project's artifacts in the PROJECT dir, never copied into K's.
    html_path   TEXT,
    -- v13 (Impressive Wave, D-117): owning project (NULL = harness-scoped) and
    -- provenance. origin='compiled' rows are written by K's compilers (bible /
    -- ui-demo / saveArtifact); origin='scanned' rows are filesystem-discovered
    -- loose HTML managed by artifact-scan.ts (deleted when their file vanishes,
    -- never touched by the compilers). project_id has NO ON DELETE action by
    -- contract — db.deleteProject cleans artifacts rows explicitly (BE.2).
    project_id  TEXT REFERENCES projects(id),
    origin      TEXT NOT NULL DEFAULT 'compiled' CHECK(origin IN ('compiled','scanned'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    local_path        TEXT NOT NULL,
    github_remote     TEXT,
    workspace_managed INTEGER NOT NULL DEFAULT 0,
    bible_dir         TEXT NOT NULL DEFAULT 'artifacts/bible',
    -- The repo's real default branch (detected at register/clone). Nullable: pre-
    -- migration rows stay NULL and callers fall back to a heuristic (W4 follow-up).
    default_branch    TEXT,
    -- Operator-authored verification recipe (SCHEMA_VERSION 8, P0 — E-04
    -- groundwork): JSON matching @k/shared VerifyRecipeSchema. NULL = none
    -- configured. Appended via guarded ALTER for migrated DBs (migrateSlow).
    verify_recipe     TEXT,
    -- P2 (SCHEMA_VERSION 10): per-project auto-merge toggle (E-06). Default OFF.
    auto_merge        INTEGER NOT NULL DEFAULT 0,
    health_score      INTEGER,
    last_verified_at  INTEGER,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verification_reports (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    -- nullable: NULL = insufficient signal (no dimension measured — the health score
    -- prorates over measured dimensions only; F-032 rework). Existing NOT-NULL DBs are
    -- rebuilt to nullable in migrateSlow.
    score         INTEGER,
    findings      TEXT NOT NULL DEFAULT '[]',
    fixes_applied TEXT NOT NULL DEFAULT '[]',
    started_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_verification_project ON verification_reports(project_id, started_at);

  -- ── P1 Trust Core (SCHEMA_VERSION 9) ────────────────────────────────────────
  -- Inline review comments on a run's diff (E-01). Anchored file+line+side against
  -- the DETERMINISTIC checkpoint diff (immutable shas), so no hunk-id indirection.
  -- status: draft (composed) → sent (bundled into a fix run) → resolved.
  CREATE TABLE IF NOT EXISTS review_comments (
    id         TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs(id),
    file       TEXT NOT NULL,
    line       INTEGER,
    side       TEXT NOT NULL DEFAULT 'new' CHECK(side IN ('old','new')),
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','resolved')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_comments_run ON review_comments(run_id, created_at);

  -- ONE current verify result per run (E-04) — upserted on re-verify. Its own
  -- table (not a runs column): keeps the hot runs row narrow + FK-cleanable.
  CREATE TABLE IF NOT EXISTS verify_results (
    run_id       TEXT PRIMARY KEY REFERENCES runs(id),
    status       TEXT NOT NULL CHECK(status IN ('running','pass','fail','skipped','error')),
    reason       TEXT,
    commands     TEXT NOT NULL DEFAULT '[]',
    scope        TEXT,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER
  );

  -- ── P2 Human Gates (SCHEMA_VERSION 10) ──────────────────────────────────────
  -- E-02: one CURRENT plan per plan-gated run (last-wins edits; no history table —
  -- the verify_results rationale). plan = PlanDoc JSON, NULL when the model's plan
  -- turn produced no parseable fenced json (raw still carries the turn text).
  CREATE TABLE IF NOT EXISTS run_plans (
    run_id      TEXT PRIMARY KEY REFERENCES runs(id),
    plan        TEXT,
    raw         TEXT NOT NULL,
    edited      INTEGER NOT NULL DEFAULT 0,
    profile_id  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    approved_at INTEGER
  );

  -- E-19: the durable in-app notification center. run_id/project_id are LOOSE refs
  -- (no FK): notifications are history that outlives runs/projects.
  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    event_key  TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT,
    run_id     TEXT,
    project_id TEXT,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

  -- E-19: event key → channels. Seeded in migrateSlow (INSERT OR IGNORE); the
  -- notify engine also carries in-code defaults so a missing row never crashes it.
  CREATE TABLE IF NOT EXISTS notification_rules (
    event_key TEXT PRIMARY KEY,
    inapp     INTEGER NOT NULL DEFAULT 1,
    browser   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS github_cache (
    project_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- 'pr' | 'ci'
    payload     TEXT NOT NULL,            -- JSON array
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, kind)
  );

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
    task_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
    mode         TEXT NOT NULL DEFAULT 'combined',
    workflow_id  TEXT,   -- loose ref (intentionally no FK): the workflow_definitions TEMPLATE the run was dispatched from (F-074); NULL = a default code-wave dispatch. Kept loose so deleting a definition never cascades into run history.
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

  -- Skills: the automation registry, EXTENDED into the unified capability catalog
  -- (SCHEMA_VERSION 7, D-069). Host-discovered skills (claude-user/-project/-plugin)
  -- land as rows here alongside the k-native ones; the D-069 catalog columns carry
  -- provenance + scan state. UNIQUE lives on qualified_key (the canonical D-069 key;
  -- k-native rows use the bare name, so k-native name-uniqueness is preserved), NOT
  -- on name — the same skill NAME may exist from several sources. Pre-v7 DBs are
  -- rebuilt to this exact shape in migrateSlow (UNIQUE moved name → qualified_key).
  CREATE TABLE IF NOT EXISTS skills (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    type         TEXT NOT NULL CHECK(type IN ('skill','hook','workflow')),
    source       TEXT NOT NULL,
    triggerType  TEXT NOT NULL CHECK(triggerType IN ('manual','schedule','event')),
    schedule     TEXT,
    eventTrigger TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    createdAt    INTEGER NOT NULL,
    -- D-069 catalog columns. source_kind: 'k' | 'claude-user' | 'claude-project' |
    -- 'claude-plugin' (no CHECK — the enum is owned by the Zod boundary so adding a
    -- kind never needs a table rebuild). origin_path/project_id/plugin_* are
    -- discovery provenance (NULL for k-native automation rows); est_tokens[_meta]
    -- are the chars/4 estimates (token-estimate.ts); status 'ok'|'missing' is the
    -- fail-closed liveness flag; qualified_key is the canonical wire id.
    -- project_id is DELIBERATELY a loose ref (no FK, unlike host_mcp_servers):
    -- deleting/deregistering a project must never FK-block on its discovered
    -- skill rows — per D-069 they degrade to status='missing' at the next rescan.
    source_kind     TEXT NOT NULL DEFAULT 'k',
    origin_path     TEXT,
    project_id      TEXT,
    plugin_id       TEXT,
    plugin_version  TEXT,
    content_hash    TEXT,
    est_tokens      INTEGER,
    est_tokens_meta INTEGER,
    status          TEXT NOT NULL DEFAULT 'ok',
    last_scanned_at INTEGER,
    qualified_key   TEXT NOT NULL UNIQUE
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

  -- ── Host MCP servers (SCHEMA_VERSION 7, D-070) ───────────────────────────────
  -- MCP servers DISCOVERED from the host layer (~/.claude.json user+project scopes,
  -- project .mcp.json). Trust is SEPARATE from enable: trusted_hash pins the
  -- reviewed config_hash; enabling requires trust; hash drift on rescan
  -- auto-disables + clears trust; synth re-hashes the live config and throws on
  -- mismatch (TOCTOU close). env stores JSON — VALUES never leave core (the API
  -- exposes env NAMES only). Everything lands default-DISABLED (enabled=0).
  -- Also created in migrateSlow (CREATE IF NOT EXISTS) for migrated/fixture DBs.
  CREATE TABLE IF NOT EXISTS host_mcp_servers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    qualified_key   TEXT NOT NULL UNIQUE,
    source_kind     TEXT NOT NULL CHECK(source_kind IN ('claude-user','claude-project')),
    project_id      TEXT REFERENCES projects(id),
    command         TEXT NOT NULL,
    args            TEXT NOT NULL DEFAULT '[]',
    env             TEXT NOT NULL DEFAULT '{}',
    config_hash     TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 0,
    trusted_hash    TEXT,
    trusted_at      INTEGER,
    -- P2 (SCHEMA_VERSION 10): inbox card dismissal pinned to config_hash (E-05) — config
    -- drift auto-resurfaces the card (the trusted_hash pinning idiom).
    inbox_dismissed_hash TEXT,
    est_tokens      INTEGER,
    probe_status    TEXT,
    status          TEXT NOT NULL DEFAULT 'ok',
    discovered_at   INTEGER NOT NULL,
    last_scanned_at INTEGER
  );

  -- ── Skill Creator drafts (SCHEMA_VERSION 7, D-071) ───────────────────────────
  -- Agent-generated skill drafts (build → refine → evaluate → save). run_id /
  -- saved_skill_id are LOOSE refs (no FK — the workflow_runs.workflow_id
  -- precedent) so deleting a run or skill never cascades into draft history.
  -- Also created in migrateSlow (CREATE IF NOT EXISTS) for migrated/fixture DBs.
  CREATE TABLE IF NOT EXISTS skill_drafts (
    id             TEXT PRIMARY KEY,
    name_hint      TEXT,
    brief          TEXT NOT NULL,
    skill_md       TEXT,
    revision       INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'drafting' CHECK(status IN ('drafting','ready','failed')),
    run_id         TEXT,
    saved_skill_id TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
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
    -- v13 (P5-FU-5): free-text failure reason for FAILED results — the runner sink
    -- derives it (error string, else deterministic criticalFailures); the E-27
    -- lesson gate (lesson-proposals.ts) groups on it. NULL for passes.
    failure_reason TEXT,
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

  -- A ticket. scope (added via migrate ALTER) discriminates the store: 'run' is the
  -- EPHEMERAL default — a ticket visible only to the run that created it; 'personal'
  -- and 'org' are the DURABLE operator-global store (persist across sessions + runs);
  -- 'project' is the project task surface — the former project_tasks store, fully
  -- collapsed here in P5.1d2b (project_id/completed_at/issue_number/issue_url/
  -- issue_state are appended via migrate ALTER, like scope). run_id is the managed run
  -- that created it (resolved from K_RUN_ID; provenance) — ON DELETE SET NULL keeps the
  -- ticket if its run is later removed.
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

  -- ── logistics working store (P5.1a; operator-durable, A1) ────────────────────
  -- K's secretary-tier logistics store: notes, calendar events, and reminders the
  -- secretary reaches through the logistics MCP server (calendar/notes/scheduling)
  -- — STORAGE, not execution. OPERATOR-DURABLE (single operator): rows persist across
  -- sessions + runs and any session may read/mutate them; run_id is PROVENANCE only
  -- (the managed run that created the row, resolved from K_RUN_ID), ON DELETE SET NULL
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

  -- ── management working store (Chief org — P5.2a; durable reads, A1) ──────────
  -- The Chief's management store: assignments (an objective handed to a lead) and
  -- reports (a status write up the chain). Management is STORAGE, not execution —
  -- persisting an assignment here does NOT dispatch the lead (autonomous delegation
  -- is P5.2b). WRITES stay run-scoped (a run mutates only its own rows); READS are
  -- DURABLE across Chief activations (assignment_list / report_list). run_id is the
  -- managed run that created the row (resolved from K_RUN_ID); ON DELETE SET NULL
  -- keeps the row if its run is later removed. projects is a JSON array (scope_projects).
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
  -- CREATE TABLE IF NOT EXISTS (fresh installs); later columns are appended via
  -- migrateSlow ALTERs (v6 cli_session_id; v16 profile_id + last_read_at), so
  -- migrated DBs may order them after the columns below.
  CREATE TABLE IF NOT EXISTS k_threads (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
    active_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    -- The stable Claude CLI session id this thread's K asks resume (W7a, F-054).
    -- NULL until the first ask answers successfully; thereafter every ask runs
    -- claude -p --resume <cli_session_id> so continuity comes from a cheap cache-read
    -- of the session, not a held warm process or a replayed transcript.
    cli_session_id TEXT,
    -- Archives the thread out of the default list without deleting it (UI
    -- Simplification, SCHEMA_VERSION 11). NULL = active/unarchived.
    archived_at   INTEGER,
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

  -- Operator memory store (UI Simplification, SCHEMA_VERSION 11) — saved directly
  -- (by the operator or K's memory_save tool), no accept/reject gate (contrast
  -- Lesson, agent memory layer A). source_thread_id is loose provenance: SET NULL
  -- on thread delete keeps the memory after its originating conversation is gone.
  CREATE TABLE IF NOT EXISTS user_memories (
    id               TEXT PRIMARY KEY,
    content          TEXT NOT NULL,
    source_thread_id TEXT REFERENCES k_threads(id) ON DELETE SET NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

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
    -- P2 (SCHEMA_VERSION 10): tier default — dispatches through this profile plan-gate (E-02).
    plan_gate     INTEGER NOT NULL DEFAULT 0,
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
    workflow_id  TEXT,   -- loose ref (intentionally no FK): a workflow_definitions id (P5.3b) — kept loose so deleting a definition never cascades into run history

    status       TEXT NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','completed','failed')),
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_profile ON agent_runs(profile_id, created_at);
  -- Point-lookup index for the by-run_id reads (the Chief autonomous-wake self-wake
  -- guard fires on EVERY terminal run_update — a hot path — so run_id must be indexed).
  CREATE INDEX IF NOT EXISTS idx_agent_runs_run_id ON agent_runs(run_id);

  -- Chief→lead dispatch INTENT queue (loop-b). The mgmt dispatch_lead tool runs in the
  -- ephemeral per-Chief-run stdio mgmt-server CHILD process, which dies at the Chief's
  -- turn end — so it can only RECORD the intent to dispatch a lead, never EXECUTE it (the
  -- lead run + its report-back subscriber must outlive the child). This DB-backed queue is
  -- the child->main hand-off: dispatch_lead inserts a 'pending' row; a relay in the
  -- long-lived MAIN process (lead-dispatch-relay.ts) drains pending rows, claims each
  -- atomically (pending->dispatched), and runs startAgentRun there. status: pending ->
  -- dispatched (claimed+executed) | failed (startAgentRun threw). chief_run_id is the
  -- parent Chief run (ON DELETE SET NULL); lead_run_id is the dispatched lead's run once
  -- executed (ON DELETE SET NULL). Brand-new table -> CREATE-only (no migrate() ALTER).
  CREATE TABLE IF NOT EXISTS lead_dispatches (
    id              TEXT PRIMARY KEY,
    assignment_id   TEXT NOT NULL REFERENCES mgmt_assignments(id) ON DELETE CASCADE,
    chief_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL,
    lead_profile_id TEXT NOT NULL,
    lead            TEXT NOT NULL,
    workflow_id     TEXT NOT NULL,
    goal            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','dispatched','failed')),
    lead_run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL,
    dispatched_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_lead_dispatches_status ON lead_dispatches(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_lead_dispatches_assignment ON lead_dispatches(assignment_id);

  -- ── Pipeline Engine (D-119, SCHEMA_VERSION 14) ─────────────────────────────
  -- Executable-pipeline runtime ledger. One pipeline_runs row per instantiated
  -- PipelineSpec; its stages/edges are materialized rows (the engine mutates STATUS,
  -- never the frozen definition). Brand-new tables → CREATE-only here (no migrate()
  -- ALTER — the lead_dispatches convention), styled after agent_runs/lead_dispatches.

  -- One execution of a pipeline. status: running -> completed | failed | cancelled.
  -- base_commit is the fork point the per-edge handoff computes bases from; cwd is the
  -- scoped project's localPath. project_id ON DELETE SET NULL keeps run history if the
  -- project is later removed.
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id            TEXT PRIMARY KEY,
    definition_id TEXT,   -- loose ref (no FK): the workflow_definitions template it was instantiated from; NULL for an ad-hoc spec
    project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    cwd           TEXT NOT NULL,
    base_commit   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running'
                    CHECK(status IN ('running','completed','failed','cancelled')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status, created_at);

  -- One materialized stage of a pipeline run. spec is the frozen StageDef JSON;
  -- status walks pending -> dispatched -> running -> passed|failed (or awaiting_gate
  -- for a gate, or skipped for an untaken when-branch). run_id (ON DELETE SET NULL) is
  -- the supervised run an agent stage dispatched; result_commit is its terminal
  -- checkpoint SHA (the handoff hand-off). UNIQUE(pipeline_run_id, stage_key) makes the
  -- claim CAS + edge joins key on the stable slug.
  CREATE TABLE IF NOT EXISTS pipeline_stages (
    id               TEXT PRIMARY KEY,
    pipeline_run_id  TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    stage_key        TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK(kind IN ('agent','deterministic','gate','hook')),
    profile_id       TEXT,
    spec             TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','dispatched','running','awaiting_gate','passed','failed','skipped')),
    run_id           TEXT REFERENCES runs(id) ON DELETE SET NULL,
    base_commit      TEXT,
    result_commit    TEXT,
    exit_code        INTEGER,
    failure_class    TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    repair_stage_key TEXT,
    repairs_used     INTEGER NOT NULL DEFAULT 0,
    gate_resolved_by TEXT,
    gate_note        TEXT,
    cost_usd         REAL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    started_at       INTEGER,
    completed_at     INTEGER,
    UNIQUE(pipeline_run_id, stage_key)
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run ON pipeline_stages(pipeline_run_id, status);
  CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run_id ON pipeline_stages(run_id);

  -- The materialized DAG edges of a pipeline run (from_stage_key NULL = an entry edge).
  -- handoff = the per-edge base-commit rule; when_cond = the branch predicate.
  CREATE TABLE IF NOT EXISTS pipeline_edges (
    id              TEXT PRIMARY KEY,
    pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    from_stage_key  TEXT,
    to_stage_key    TEXT NOT NULL,
    handoff         TEXT NOT NULL CHECK(handoff IN ('share-tree','branch','merge')),
    when_cond       TEXT NOT NULL DEFAULT 'always'
                      CHECK(when_cond IN ('always','pass','fail','repair','loop'))
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_edges_to ON pipeline_edges(pipeline_run_id, to_stage_key);

  -- K/Chief -> pipeline dispatch INTENT queue — mirrors lead_dispatches exactly (the
  -- child delegate_pipeline tool RECORDS a 'pending' intent; the main-process relay
  -- drains + claims + calls startPipelineRun). status: pending -> dispatched | failed.
  -- k_run_id is the parent K/Chief run; pipeline_run_id is the started pipeline once
  -- executed (both ON DELETE SET NULL).
  CREATE TABLE IF NOT EXISTS pipeline_dispatches (
    id              TEXT PRIMARY KEY,
    pipeline_id     TEXT NOT NULL,
    k_run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
    goal            TEXT NOT NULL,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    model           TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','dispatched','failed')),
    pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL,
    dispatched_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_dispatches_status ON pipeline_dispatches(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_dispatches_project ON pipeline_dispatches(project_id);

  -- Run-internal hook registry — the PreToolUse/PostToolUse/PreSkill scripts
  -- synthesizeConfigDir mounts into a run's settings.json. source 'k' = harness-native
  -- (agent-config/hooks/*, always trusted); 'operator' = confined data/hooks/<id>/,
  -- fail-closed until trusted=1 (the hook_trust Inbox card). scope tiers global ->
  -- project -> pipeline. Brand-new table -> CREATE-only.
  CREATE TABLE IF NOT EXISTS hook_definitions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    event       TEXT NOT NULL CHECK(event IN ('PreToolUse','PostToolUse','PreSkill')),
    matcher     TEXT NOT NULL,
    impl        TEXT NOT NULL,
    timeout_sec INTEGER NOT NULL DEFAULT 10,
    scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','project','pipeline')),
    project_id  TEXT,
    source      TEXT NOT NULL DEFAULT 'operator' CHECK(source IN ('k','operator')),
    trusted     INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- ── Orchestration Program Phase 2 W0 (SCHEMA_VERSION 15, D-120) ─────────────
  -- Sub Agents = the editable worker-bee registry an 'agent' StageDef's
  -- subagentType resolves against (design §3, shared/src/types.ts
  -- StageDefSchema.subagentType). Operator rows live here; K-native workers
  -- resolve from agent-config/agents/*.md at read time (source:'k', not
  -- persisted) — mirrors the hook_definitions source:'k'/'operator' split
  -- above. allowed_tools/mcp_servers/skills are JSON-encoded TEXT (mirrors
  -- agent_profiles). Brand-new table -> CREATE-only.
  CREATE TABLE IF NOT EXISTS sub_agent_defs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL,
    model         TEXT,
    allowed_tools TEXT NOT NULL,
    mcp_servers   TEXT NOT NULL,
    skills        TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'operator',
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- Append-only per-pipeline-run progress ledger (design §6.1): every stage
  -- transition, retry, loop iteration, gate decision, and cost event the
  -- engine records, plus free-text notes. seq is a monotonic per-run cursor
  -- (pipelineLedgerDb.insertLedgerEntry assigns MAX(seq)+1 atomically) so a
  -- client can fetch only rows newer than a known seq (the pipeline_update
  -- WsMessage's ledgerSeq). stage_key is nullable (run-level entries);
  -- detail is JSON-encoded TEXT. No FK on pipeline_run_id (per spec) — the
  -- ledger is an independent append-only log. Brand-new table -> CREATE-only.
  CREATE TABLE IF NOT EXISTS pipeline_ledger (
    id              TEXT PRIMARY KEY,
    pipeline_run_id TEXT NOT NULL,
    stage_key       TEXT,
    seq             INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    actor           TEXT,
    goal            TEXT,
    detail          TEXT,
    cost            REAL,
    UNIQUE(pipeline_run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_ledger_run ON pipeline_ledger(pipeline_run_id, seq);

  -- ── Continuous Agents W0 (SCHEMA_VERSION 16, D-122..D-127) ──────────────────
  -- Domains registry (D-125): a domain groups agent profiles + pipeline
  -- definitions under a manager profile whose supervision loop
  -- (domain-supervisor.ts, Lane C) oversees every run attributed to the domain.
  -- manager_profile_id is a loose ref (no FK, CODE-enforced) — deleting a profile
  -- must never invalidate the registry. Brand-new table -> CREATE-only.
  CREATE TABLE IF NOT EXISTS domains (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    description        TEXT,
    manager_profile_id TEXT,
    created_at         INTEGER NOT NULL
  );

  -- The session layer (D-122): at most ONE session per (profile, thread) — the
  -- hybrid warm/resumable continuity record agent-sessions.ts (Lane A) drives.
  -- state walks live (warm parked process) -> resumable (cold; cli_session_id can
  -- --resume) -> stale (must re-seed). home_dir is the session's synthesized
  -- config/home dir; context_tokens is the last observed context size (the
  -- demote-at-threshold signal). profile_id/thread_id are loose refs (no FK,
  -- CODE-enforced — session history survives a deleted profile/thread, mirroring
  -- pipeline_runs.owner_profile_id). Brand-new table -> CREATE-only.
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id               TEXT PRIMARY KEY,
    profile_id       TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    cli_session_id   TEXT,
    home_dir         TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'stale' CHECK (state IN ('live','resumable','stale')),
    context_tokens   INTEGER,
    last_activity_at INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (profile_id, thread_id)
  );

  -- The priority mailbox (D-124): a DB-queue of operator/agent -> agent messages
  -- the main-process relay (message-relay.ts, Lane B) drains and delivers by the
  -- TARGET session's state — the lead_dispatches/pipeline_dispatches queue
  -- pattern. status walks queued -> delivered | failed; delivered_at is stamped
  -- on delivery ONLY. from_profile_id is set when from_kind='profile';
  -- provenance_run_id records the sending run. All loose refs (no FK,
  -- CODE-enforced — same rationale as agent_sessions). Brand-new table ->
  -- CREATE-only.
  CREATE TABLE IF NOT EXISTS agent_messages (
    id                TEXT PRIMARY KEY,
    to_profile_id     TEXT NOT NULL,
    to_thread_id      TEXT,
    from_kind         TEXT NOT NULL CHECK (from_kind IN ('user','profile')),
    from_profile_id   TEXT,
    body              TEXT NOT NULL,
    priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
    status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed')),
    provenance_run_id TEXT,
    created_at        INTEGER NOT NULL,
    delivered_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_queue ON agent_messages(to_profile_id, status);
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

/** The current schema version, stamped into PRAGMA user_version after a successful
 *  full migration scan. BUMP THIS when adding any new migration to migrateSlow()
 *  below — a DB stamped with an older version then re-runs the full scan (and is
 *  re-stamped) on its next open. Exported so tests derive the CURRENT version
 *  instead of hardcoding it. */
export const SCHEMA_VERSION = 16

/** Sentinel for the CURRENT schema version: a column the LAST migration in
 *  migrateSlow() creates. migrate()'s fast path only trusts the version stamp when
 *  this column exists — a stamp written without the columns (an intermediate
 *  dev-watch boot mid-schema-edit; the 2026-07-13 outage) otherwise disables
 *  repair forever while module-level prepares crash at import.
 *  UPDATE THIS alongside every SCHEMA_VERSION bump — it must always name a column
 *  introduced by the CURRENT version (schema-v16.test.ts enforces this with a
 *  previous-generation fixture; extend that fixture on every future bump). */
// MUST be a column that migrateSlow() ADDs (a guarded ALTER on an already-existing
// table) — NOT a column on a table built by the unconditional db.exec DDL block
// (line 22), which runs BEFORE migrate() on every open. A sentinel on such a table
// (e.g. agent_sessions.state) is created before migrate()'s check and can never be
// absent, so a poisoned stamp (v16 stamped, guarded columns missing) would silently
// fast-path past the heal. pipeline_runs.domain_id is the LAST v16 migrateSlow ALTER
// (its carrier table `pipeline_runs` is unconditional, but the COLUMN is
// migrateSlow-added), so its absence-despite-v16-stamp correctly proves the guarded
// scan didn't run.
export const SCHEMA_SENTINEL = { table: 'pipeline_runs', column: 'domain_id' } as const

/**
 * Guarded, idempotent schema evolution — runs on EVERY connection open: the main
 * server boot AND each per-run stdio MCP child (up to 3 per K/Chief turn), which is
 * why the full scan is version-gated. Fast path: user_version === SCHEMA_VERSION →
 * return immediately (the pragma lives in the DB file, so once one connection has
 * migrated + stamped, every later connection skips the scan). Slow path: run the
 * full guarded-ALTER/backfill scan (migrateSlow) then stamp the version — only on
 * success, so a failed migration retries on the next open. migrateSlow's per-step
 * idempotency (hasColumn/hasTable guards, duplicate-column tolerance, one-shot
 * flags) stays as belt-and-suspenders for the slow path and for concurrent
 * first-boots racing before the stamp lands. Exported for tests.
 *
 * Sentinel guard (2026-07-13 outage): the fast path only trusts the version stamp
 * when SCHEMA_SENTINEL's column also exists. A stamp written without the columns
 * (an intermediate dev-watch boot mid-schema-edit) otherwise disables repair
 * forever while module-level prepares crash at import — see SCHEMA_SENTINEL below.
 */
export function migrate(d: Database.Database): void {
  const stamped = d.pragma('user_version', { simple: true }) as number
  if (stamped === SCHEMA_VERSION && hasColumn(d, SCHEMA_SENTINEL.table, SCHEMA_SENTINEL.column)) return
  if (stamped === SCHEMA_VERSION) {
    console.warn(
      `[db] user_version says ${SCHEMA_VERSION} but ${SCHEMA_SENTINEL.table}.${SCHEMA_SENTINEL.column} ` +
        `is missing — poisoned stamp; re-running the full migration scan (idempotent).`,
    )
  }
  migrateSlow(d)
  d.pragma(`user_version = ${SCHEMA_VERSION}`)
}

/** The full guarded-ALTER/backfill scan (the pre-gate migrate() body, unchanged). */
function migrateSlow(d: Database.Database): void {
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
    // score NOT NULL → nullable (F-032 rework): the health score is now null when NO
    // dimension could be measured (insufficient signal). SQLite can't drop a column
    // constraint in place, so rebuild the table. Guarded on the column still being
    // NOT NULL (notnull===1) → idempotent (after the rebuild it's nullable → skip);
    // no one-shot flag needed. Runs AFTER the score_breakdown/coverage_pct ALTERs
    // above so the copied column list is complete. Nothing FKs INTO verification_reports,
    // so the rebuild is local. FKs OFF during the drop/rename (mirrors the work_items
    // rebuild idiom); the finally restores the pragma on success AND on failure.
    const scoreCol = (d.pragma('table_info(verification_reports)') as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'score')
    if (scoreCol && scoreCol.notnull === 1) {
      d.pragma('foreign_keys = OFF')
      try {
        const rebuild = d.transaction(() => {
          d.exec(`
            CREATE TABLE verification_reports_new (
              id            TEXT PRIMARY KEY,
              project_id    TEXT NOT NULL REFERENCES projects(id),
              score         INTEGER,
              findings      TEXT NOT NULL DEFAULT '[]',
              fixes_applied TEXT NOT NULL DEFAULT '[]',
              started_at    INTEGER NOT NULL,
              completed_at  INTEGER,
              score_breakdown TEXT,
              coverage_pct  REAL
            );
            INSERT INTO verification_reports_new
              (id, project_id, score, findings, fixes_applied, started_at, completed_at, score_breakdown, coverage_pct)
            SELECT id, project_id, score, findings, fixes_applied, started_at, completed_at, score_breakdown, coverage_pct
            FROM verification_reports;
            DROP TABLE verification_reports;
            ALTER TABLE verification_reports_new RENAME TO verification_reports;
            CREATE INDEX IF NOT EXISTS idx_verification_project ON verification_reports(project_id, started_at);
          `)
        })
        rebuild.immediate()
      } finally {
        d.pragma('foreign_keys = ON')
      }
    }
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
  // artifacts.html_path (SCHEMA_VERSION 3): nullable absolute path to a
  // pre-composed on-disk .html served verbatim — used to serve a REGISTERED
  // project's bible from its OWN <localPath>/artifacts/project-bible.html instead
  // of copying it into K's ARTIFACTS_DIR. Appended via guarded ALTER so existing
  // DBs gain it; fresh installs get it from the DDL above. hasTable guard keeps
  // migrate() safe against old-schema fixtures predating the table.
  if (hasTable(d, 'artifacts')) {
    addColumn(d, 'artifacts', 'html_path', 'TEXT')
  }
  // workflow_runs.workflow_id (SCHEMA_VERSION 4): the workflow_definitions TEMPLATE a run
  // was dispatched from (F-074) — so GET /api/workflows/runs can say WHICH definition each
  // run used. Loose ref (no FK), NULL for pre-F-074 rows and default code-wave dispatches.
  // Appended via guarded ALTER so existing DBs gain it; fresh installs get it from the DDL
  // above. hasTable guard keeps migrate() safe against old-schema fixtures predating the table.
  if (hasTable(d, 'workflow_runs')) {
    addColumn(d, 'workflow_runs', 'workflow_id', 'TEXT')
  }
  // projects.default_branch (SCHEMA_VERSION 5): the repo's real default branch,
  // detected + persisted at register/clone (W4 follow-up) so the PR-base default no
  // longer relies on a fragile CI-branch heuristic. Appended via guarded ALTER so
  // existing DBs gain it; fresh installs get it from the DDL above. Pre-migration rows
  // read back NULL and callers fall back to the heuristic. hasTable guard keeps
  // migrate() safe against old-schema fixtures predating the table.
  if (hasTable(d, 'projects')) {
    addColumn(d, 'projects', 'default_branch', 'TEXT')
  }
  // k_threads.cli_session_id (SCHEMA_VERSION 6, W7a / F-054): the stable Claude CLI
  // session id a K thread's asks resume, so K continuity comes from `--resume` (a cheap
  // cache-read) instead of a held warm process. Appended via guarded ALTER so existing
  // DBs gain it; fresh installs get it from the DDL above. Pre-migration rows read back
  // NULL (the "no session yet → first ask" sentinel). hasTable guard keeps migrate() safe
  // against old-schema fixtures predating the table.
  if (hasTable(d, 'k_threads')) {
    addColumn(d, 'k_threads', 'cli_session_id', 'TEXT')
  }
  // project_tasks issue columns — LEGACY-UPGRADE path ONLY (P5.1d2b). The table is
  // no longer created anywhere (dropped by the one-shot mig_project_tasks_drop
  // below), so this block exists solely to prepare a pre-d2b project_tasks table:
  // it appends the Wave 3-7 GitHub Issues sync columns so the final backfill can
  // read pt.issue_number/issue_url/issue_state from any vintage of the table. Once
  // the drop has run (or on a fresh install, where the table never exists) the
  // hasTable guard makes this a permanent no-op.
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
  // work_items.scope (D-026): the run|personal|org|project discriminator. Appended
  // via guarded ALTER (not in CREATE TABLE) exactly like score_breakdown /
  // project_tasks-issue — migrate() runs at boot so fresh installs AND pre-scope DBs
  // both gain the NEW enum. DEFAULT 'run' backfills legacy pre-scope rows to run-scoped
  // semantics — which is exactly what they were (ephemeral, single-run kstore tickets).
  // A DB that already carried the OLD scope CHECK (DEFAULT 'personal', enum without
  // 'run') is rebuilt to the new enum by the one-shot mig_work_items_run_scope below —
  // SQLite cannot alter a CHECK in place. The hasTable guard keeps migrate() safe
  // against old-schema fixtures predating the table (db-migration.test.ts).
  if (hasTable(d, 'work_items')) {
    addColumn(d, 'work_items', 'scope', "TEXT NOT NULL DEFAULT 'run' CHECK(scope IN ('run','personal','org','project'))")
  }
  // work_items project columns (P5.1d2, D-026/D-048): fold the former
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
  // project_tasks → work_items final backfill + DROP (P5.1d2b, D-026) — one-shot.
  //
  // THE STORY: d2a copied project_tasks into work_items(scope='project') but left
  // project_tasks in place as a "frozen safety copy" with this backfill running on
  // EVERY boot. Meanwhile deleteProjectTask deletes only the work_items row — so
  // any pre-d2a task deleted via the API RESURRECTED from the frozen copy on the
  // next boot (and an issue-linked one could then duplicate against a re-synced
  // row, since idx_work_items_issue is non-unique). Running the backfill one last
  // time and then DROPPING the table fixes this permanently: deletes are durable
  // because there is no frozen copy left to resurrect from. A row deleted BEFORE
  // this upgrade resurrects at most once (at the upgrade boot); after that the
  // table is gone and every delete sticks.
  //
  // The app_config flag (not just hasTable) guards the multi-process boot race —
  // the main server + per-run stdio MCP children all run migrate() on their own
  // connections — and any exotic re-appearance of the table (e.g. an old fixture
  // restored over a migrated DB) from silently re-running the backfill.
  //
  // Runs AFTER the work_items project columns above exist and AFTER the
  // project_tasks legacy-upgrade ALTER earlier in migrate(), so every SELECT
  // column is present. Idempotent within the one shot (NOT EXISTS keys on the
  // reused project_task id === work_item id). project_tasks.status values
  // (open/in_progress/done) all satisfy the work_items status CHECK. run_id is
  // NULL (project-scoped, not run-scoped); scope is stamped 'project'. No
  // foreign_keys toggling is needed for the DROP: nothing references INTO
  // project_tasks (its own FK out to projects simply disappears with it).
  d.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const D2B_FLAG = 'mig_project_tasks_drop'
  const d2bDone = d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(D2B_FLAG)
  if (hasTable(d, 'work_items') && hasTable(d, 'project_tasks') && !d2bDone) {
    const applyProjectTasksDrop = d.transaction(() => {
      // Race re-check INSIDE the lock: the pre-check above is the fast path but is
      // computed BEFORE .immediate() acquires the write lock — a process that lost
      // the boot race must no-op instead of re-running against the dropped table.
      if (d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(D2B_FLAG)) return
      d.exec(`
        INSERT INTO work_items (id, run_id, project_id, title, body, status, scope, created_at, updated_at, completed_at, issue_number, issue_url, issue_state)
        SELECT pt.id, NULL, pt.project_id, pt.title, NULL, pt.status, 'project', pt.created_at, pt.created_at, pt.completed_at, pt.issue_number, pt.issue_url, pt.issue_state
        FROM project_tasks pt
        WHERE NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id = pt.id)
      `)
      d.exec(`DROP TABLE project_tasks`)
      d.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(D2B_FLAG)
    })
    applyProjectTasksDrop.immediate()
  }
  // agent_profiles.default_model reset (B1). Historically seeds froze the literal
  // 'claude-sonnet-4-6' into every row, which silently pinned org runs and bypassed
  // the operator's runtime Claude default (config-store claudeDefaultModel). One-shot
  // (app_config flag): rows still carrying that exact frozen literal become '' (the
  // "use runtime default" sentinel — see rowToAgentProfile); an operator-set override
  // that DIFFERS survives. One-shot so an operator explicitly re-pinning
  // 'claude-sonnet-4-6' later is never wiped by a subsequent boot.
  if (hasTable(d, 'agent_profiles') && hasColumn(d, 'agent_profiles', 'default_model') && hasTable(d, 'app_config')) {
    const FLAG = 'migration.agentProfileModelReset.v1'
    if (!d.prepare(`SELECT value FROM app_config WHERE key = ?`).get(FLAG)) {
      d.prepare(`UPDATE agent_profiles SET default_model = '' WHERE default_model = 'claude-sonnet-4-6'`).run()
      d.prepare(`INSERT INTO app_config (key, value) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(FLAG)
    }
  }

  // work_items run-scope rename (A1, D-026): the durable operator-global store. A DB
  // that already carried the OLD scope column (DEFAULT 'personal', CHECK without 'run')
  // must be REBUILT — SQLite cannot alter a CHECK in place — and its legacy 'personal'
  // AND 'org' rows re-stamped 'run': BOTH were reachable via work_item_create pre-A1
  // and behaved identically run-scoped (reads filtered `run_id IS ? AND scope !=
  // 'project'`), and there are no DURABLE rows yet. Flag-guarded one-shot: WITHOUT the
  // flag, the plain →run UPDATE would clobber every future durable 'personal'/'org'
  // row on every boot — the flag is exactly what makes this a one-time migration.
  // app_config is created first because old-schema test fixtures lack it (idempotent,
  // matches the main DDL).
  d.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const RUN_SCOPE_FLAG = 'mig_work_items_run_scope'
  const runScopeDone = d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)
  if (hasTable(d, 'work_items') && !runScopeDone) {
    const ddl = d
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`)
      .get() as { sql?: string } | undefined
    // run_id / runs(id) are UNQUOTED identifiers, so /'run'/ (the quoted CHECK literal)
    // can't false-positive: its absence means the table carries the OLD CHECK enum.
    const needsRebuild = ddl?.sql != null && !/'run'/.test(ddl.sql)
    // ONE IMMEDIATE transaction (auto-ROLLBACK on throw — the codebase's safe-migration
    // idiom, mirroring db.transaction elsewhere): rebuild (when needed) + the
    // personal→run re-stamp + the flag commit atomically, so a mid-migration failure can
    // never leave a half-rebuilt table, a re-stamp without its flag, or a dangling open
    // transaction on this connection.
    const applyRunScopeMigration = d.transaction(() => {
      // Race re-check INSIDE the lock (multi-process boot: the main server + up to
      // three per-run stdio MCP children each open k.db and run migrate() on their own
      // connections). The pre-checks above (flag + needsRebuild) are the fast path but
      // are computed BEFORE .immediate() acquires the write lock — a process that lost
      // the race would otherwise redo the full rebuild against the already-rebuilt
      // table. If the winner already committed the flag, no-op out.
      if (d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUN_SCOPE_FLAG)) return
      if (needsRebuild) {
        // Copy → drop → rename a NEW table with the current schema. Renaming the NEW
        // table (referenced by nothing) avoids RENAME rewriting other tables' FK clauses.
        d.exec(`
          CREATE TABLE work_items_new (
            id          TEXT PRIMARY KEY,
            run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
            title       TEXT NOT NULL,
            body        TEXT,
            status      TEXT NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open','in_progress','blocked','done','cancelled')),
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            scope       TEXT NOT NULL DEFAULT 'run'
                          CHECK(scope IN ('run','personal','org','project')),
            project_id   TEXT REFERENCES projects(id),
            completed_at INTEGER,
            issue_number INTEGER,
            issue_url    TEXT,
            issue_state  TEXT
          );
          INSERT INTO work_items_new
            (id, run_id, title, body, status, created_at, updated_at, scope, project_id, completed_at, issue_number, issue_url, issue_state)
          SELECT
            id, run_id, title, body, status, created_at, updated_at, scope, project_id, completed_at, issue_number, issue_url, issue_state
          FROM work_items;
          DROP TABLE work_items;
          ALTER TABLE work_items_new RENAME TO work_items;
          CREATE INDEX IF NOT EXISTS idx_work_items_run ON work_items(run_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_work_items_issue ON work_items(project_id, issue_number);
        `)
      }
      // Re-stamp legacy 'personal' AND 'org' rows to 'run' — both were creatable via
      // kstore pre-A1 and behaved identically run-scoped; an untouched legacy 'org' row
      // would otherwise silently ESCALATE into the durable operator-global view on the
      // upgrade boot. Guarded one-shot: the flag (committed in the SAME transaction)
      // stops this from ever clobbering a future durable 'personal'/'org' row.
      d.exec(`UPDATE work_items SET scope = 'run' WHERE scope IN ('personal','org')`)
      d.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RUN_SCOPE_FLAG)
    })
    if (needsRebuild) {
      // FKs OFF so DROP TABLE doesn't fire workflow_steps.work_item_id's ON DELETE SET
      // NULL (ids are preserved in the copy) and the copy is unchecked. The pragma must
      // be toggled OUTSIDE the transaction (foreign_keys is a no-op inside one); the
      // finally restores it on success AND on a (rolled-back) failure.
      d.pragma('foreign_keys = OFF')
      try {
        applyRunScopeMigration.immediate()
      } finally {
        d.pragma('foreign_keys = ON')
      }
    } else {
      applyRunScopeMigration.immediate()
    }
  }

  // (project_id, issue_number) dedupe + partial UNIQUE index (P5.1d2b): closes the
  // syncIssues double-mirror hole — the pre-existing idx_work_items_issue is
  // NON-unique, and getProjectTaskByIssue had no ORDER BY, so one GitHub issue
  // could mirror into two scope='project' rows (e.g. a resurrected pre-d2a row
  // racing a re-synced one). Dedupe first (creating a unique index over dups
  // throws): the survivor is the newest created_at, rowid DESC as a deterministic
  // tiebreak. `AND project_id IS NOT NULL` keeps NULL-project rows out of the
  // dedupe partitions (SQLite window PARTITION BY groups NULLs together, while
  // the partial unique index treats NULLs as distinct anyway). Guarded on the
  // index's absence AND created with IF NOT EXISTS, matching the events-dedupe
  // idiom: the absence pre-check skips the (idempotent) DELETE on later boots,
  // while IF NOT EXISTS absorbs the multi-process boot race — two connections
  // can both pass the pre-check, and the loser must no-op instead of throwing
  // "index already exists" out of its boot.
  //
  // MUST stay AFTER the run-scope rebuild above: the rebuild drops + recreates
  // work_items with only its own CREATE-INDEX list (which deliberately excludes
  // this index — the rebuild copies rows BEFORE dedupe could run, so creating the
  // unique index there could throw on a dup-carrying DB). On the one upgrade boot
  // where both run, the rebuild happens first, then this block dedupes and
  // recreates the index.
  if (
    hasTable(d, 'work_items') &&
    !d.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_work_items_project_issue'`).get()
  ) {
    d.exec(`
      DELETE FROM work_items
      WHERE scope = 'project' AND issue_number IS NOT NULL AND project_id IS NOT NULL
        AND rowid NOT IN (
          SELECT rowid FROM (
            SELECT rowid, ROW_NUMBER() OVER (
              PARTITION BY project_id, issue_number
              ORDER BY created_at DESC, rowid DESC
            ) AS rn
            FROM work_items
            WHERE scope = 'project' AND issue_number IS NOT NULL AND project_id IS NOT NULL
          ) WHERE rn = 1
        )
    `)
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_project_issue ON work_items(project_id, issue_number) WHERE scope = 'project' AND issue_number IS NOT NULL`)
  }

  // agent_memory.profile_id backfill (A1): resolve each pre-existing gated lesson's
  // proposing profile from its source run's most-recent agent_runs row, so durable
  // memory can grow into per-profile retrieval. Best-effort by design — a lesson whose
  // run has no agent_runs row stays NULL. Flag-guarded one-shot (kstore lessonPropose
  // now binds profile_id on new inserts). Guarded on hasColumn too, for exotic fixtures
  // whose agent_memory predates the profile_id ALTER above.
  const MEM_BACKFILL_FLAG = 'mig_agent_memory_profile_backfill'
  const memBackfillDone = d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(MEM_BACKFILL_FLAG)
  if (
    !memBackfillDone &&
    hasTable(d, 'agent_memory') &&
    hasTable(d, 'agent_runs') &&
    hasColumn(d, 'agent_memory', 'profile_id')
  ) {
    d.exec(`
      UPDATE agent_memory
      SET profile_id = (
        SELECT ar.profile_id FROM agent_runs ar
        WHERE ar.run_id = agent_memory.run_id
        ORDER BY ar.created_at DESC LIMIT 1
      )
      WHERE profile_id IS NULL AND run_id IS NOT NULL
    `)
    d.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MEM_BACKFILL_FLAG)
  }

  // Seed-profile authority resync (SCHEMA_VERSION 2) — flag-guarded one-shot.
  //
  // THE STORY: DBs seeded BEFORE B1 carry authority arrays FROZEN at seed time.
  // Verified live: an upgraded DB's `chief` row lacked mcp__mgmt/mgmt, so B1
  // row-enforcement (the synthesizer honoring profile rows) stripped the Chief's
  // management server on exactly the DBs that upgraded — fresh DBs are correct.
  // Pre-B1 the profile editors were cosmetic, so no seed row was ever
  // operator-authored → re-syncing the SEED ids from resolveAuthority(row.charter)
  // is safe. OVERWRITE WINDOW (documented honestly): an operator narrowing made to
  // a SEED row after B1 but before this upgrade boot is overwritten ONCE here;
  // operator-CREATED profiles (uuid ids) are never touched, and the one-shot flag
  // means later narrowings survive every subsequent boot.
  //
  // D2B transaction idiom: flag pre-check fast path, .immediate() transaction,
  // flag re-check INSIDE the lock (multi-process boot race), flag written in the
  // same transaction. hasTable/hasColumn guards keep migrate() safe against
  // old-schema fixtures whose agent_profiles predates the authority columns.
  //
  // resolveAuthority reads the agent-config/ assets and is DELIBERATELY uncaught:
  // a broken asset fails the migration loudly, the version stamp never lands, and
  // the next boot retries (this file's stated contract). Swallowing the throw and
  // committing the flag would instead strand stale rows forever — silently
  // defeating this migration. The main server already fail-closes on the same
  // assets at module init (profiles.ts resolveAuthority), and per-run MCP children
  // share an already-migrated k.db (the server stamps before it can spawn runs),
  // so they fast-path the version gate and never reach this read in practice.
  const RESYNC_FLAG = 'mig_seed_profile_authority_resync'
  const resyncDone = d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RESYNC_FLAG)
  if (
    !resyncDone &&
    hasTable(d, 'agent_profiles') &&
    hasColumn(d, 'agent_profiles', 'charter') &&
    hasColumn(d, 'agent_profiles', 'allowed_tools') &&
    hasColumn(d, 'agent_profiles', 'mcp_servers') &&
    hasColumn(d, 'agent_profiles', 'skills')
  ) {
    // Exactly profiles.ts SEED_PROFILES ids (cross-checked) — the durable rows the
    // boot seed stands up. Operator-created rows get uuid ids and never match.
    const SEED_PROFILE_IDS = ['k-secretary', 'chief', 'default-orchestrator', 'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']
    const applySeedProfileResync = d.transaction(() => {
      if (d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RESYNC_FLAG)) return
      const selectCharter = d.prepare(`SELECT charter FROM agent_profiles WHERE id = ?`)
      const updateAuthority = d.prepare(
        `UPDATE agent_profiles SET allowed_tools = ?, mcp_servers = ?, skills = ? WHERE id = ?`,
      )
      for (const id of SEED_PROFILE_IDS) {
        const row = selectCharter.get(id) as { charter?: string } | undefined
        if (!row) continue
        const charter = row.charter
        // Defensive: never brick boot on an exotic row — only the three durable
        // charters have assets to resolve from.
        if (charter !== 'secretary' && charter !== 'chief' && charter !== 'orchestrator') continue
        const auth = resolveAuthority(charter)
        updateAuthority.run(
          JSON.stringify(auth.allowedTools),
          JSON.stringify(auth.mcpServers),
          JSON.stringify(auth.skills),
          id,
        )
      }
      d.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RESYNC_FLAG)
    })
    applySeedProfileResync.immediate()
  }

  // ── Capability catalog (SCHEMA_VERSION 7 — D-069/D-070/D-071) ────────────────
  // skills gains the host-discovery catalog columns + the canonical qualified_key,
  // and UNIQUE moves name → qualified_key via a table rebuild. host_mcp_servers
  // and skill_drafts are (re)created here so migrated DBs AND fixture DBs handed
  // straight to migrate() gain them (fresh installs get them from the DDL above).
  if (hasTable(d, 'skills')) {
    // Appended via guarded ALTERs so pre-v7 DBs gain the columns; fresh installs
    // already carry them (no-op). qualified_key is added NULLABLE first, then
    // backfilled `= name` — the D-069 k-native grammar is the bare name, so
    // existing rows/profiles need zero migration — and the rebuild below is what
    // enforces NOT NULL + UNIQUE on it.
    addColumn(d, 'skills', 'source_kind', "TEXT NOT NULL DEFAULT 'k'")
    addColumn(d, 'skills', 'origin_path', 'TEXT')
    addColumn(d, 'skills', 'project_id', 'TEXT')
    addColumn(d, 'skills', 'plugin_id', 'TEXT')
    addColumn(d, 'skills', 'plugin_version', 'TEXT')
    addColumn(d, 'skills', 'content_hash', 'TEXT')
    addColumn(d, 'skills', 'est_tokens', 'INTEGER')
    addColumn(d, 'skills', 'est_tokens_meta', 'INTEGER')
    addColumn(d, 'skills', 'status', "TEXT NOT NULL DEFAULT 'ok'")
    addColumn(d, 'skills', 'last_scanned_at', 'INTEGER')
    addColumn(d, 'skills', 'qualified_key', 'TEXT')
    d.exec(`UPDATE skills SET qualified_key = name WHERE qualified_key IS NULL`)

    // UNIQUE moves name → qualified_key: SQLite can't drop a column UNIQUE in
    // place, so rebuild (the proven verification_reports / work_items idiom:
    // FKs OFF outside the transaction, IMMEDIATE transaction, create-new →
    // INSERT…SELECT → drop → rename). The skill_runs/skill_evals FKs reference
    // skills.id (TEXT values, copied unchanged) — that is what FK integrity
    // rides on; rowids are ALSO copied explicitly as belt-and-suspenders table
    // identity (cheap, and keeps any rowid-based tooling/ordering stable). The
    // new table matches the fresh-install DDL exactly, so both paths converge
    // on one schema.
    // Idempotency guard: rebuild ONLY while the sqlite_master DDL still carries
    // the OLD `name … UNIQUE` — after the rebuild (or on a fresh install) this
    // is a permanent no-op.
    const OLD_NAME_UNIQUE_RE = /\bname\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i
    const skillsDdl = d
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'`)
      .get() as { sql?: string } | undefined
    if (skillsDdl?.sql != null && OLD_NAME_UNIQUE_RE.test(skillsDdl.sql)) {
      d.pragma('foreign_keys = OFF')
      try {
        const applySkillsRebuild = d.transaction(() => {
          // Race re-check INSIDE the lock (multi-process boot: main server + per-run
          // stdio MCP children each run migrate()): a process that lost the race
          // must no-op instead of re-running against the already-rebuilt table.
          const current = d
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'`)
            .get() as { sql?: string } | undefined
          if (!(current?.sql != null && OLD_NAME_UNIQUE_RE.test(current.sql))) return
          d.exec(`
            CREATE TABLE skills_new (
              id           TEXT PRIMARY KEY,
              name         TEXT NOT NULL,
              description  TEXT,
              type         TEXT NOT NULL CHECK(type IN ('skill','hook','workflow')),
              source       TEXT NOT NULL,
              triggerType  TEXT NOT NULL CHECK(triggerType IN ('manual','schedule','event')),
              schedule     TEXT,
              eventTrigger TEXT,
              enabled      INTEGER NOT NULL DEFAULT 1,
              createdAt    INTEGER NOT NULL,
              source_kind     TEXT NOT NULL DEFAULT 'k',
              origin_path     TEXT,
              project_id      TEXT,
              plugin_id       TEXT,
              plugin_version  TEXT,
              content_hash    TEXT,
              est_tokens      INTEGER,
              est_tokens_meta INTEGER,
              status          TEXT NOT NULL DEFAULT 'ok',
              last_scanned_at INTEGER,
              qualified_key   TEXT NOT NULL UNIQUE
            );
            INSERT INTO skills_new (rowid, id, name, description, type, source, triggerType,
              schedule, eventTrigger, enabled, createdAt, source_kind, origin_path, project_id,
              plugin_id, plugin_version, content_hash, est_tokens, est_tokens_meta, status,
              last_scanned_at, qualified_key)
            SELECT rowid, id, name, description, type, source, triggerType,
              schedule, eventTrigger, enabled, createdAt, source_kind, origin_path, project_id,
              plugin_id, plugin_version, content_hash, est_tokens, est_tokens_meta, status,
              last_scanned_at, qualified_key
            FROM skills;
            DROP TABLE skills;
            ALTER TABLE skills_new RENAME TO skills;
          `)
        })
        applySkillsRebuild.immediate()
      } finally {
        d.pragma('foreign_keys = ON')
      }
    }
  }
  // host_mcp_servers (D-070) + skill_drafts (D-071): CREATE IF NOT EXISTS keeps
  // this idempotent AND race-safe across concurrent first-boots. The DDL matches
  // the fresh-install block above EXACTLY (one schema, two entry points).
  d.exec(`
    CREATE TABLE IF NOT EXISTS host_mcp_servers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      qualified_key   TEXT NOT NULL UNIQUE,
      source_kind     TEXT NOT NULL CHECK(source_kind IN ('claude-user','claude-project')),
      project_id      TEXT REFERENCES projects(id),
      command         TEXT NOT NULL,
      args            TEXT NOT NULL DEFAULT '[]',
      env             TEXT NOT NULL DEFAULT '{}',
      config_hash     TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 0,
      trusted_hash    TEXT,
      trusted_at      INTEGER,
      est_tokens      INTEGER,
      probe_status    TEXT,
      status          TEXT NOT NULL DEFAULT 'ok',
      discovered_at   INTEGER NOT NULL,
      last_scanned_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS skill_drafts (
      id             TEXT PRIMARY KEY,
      name_hint      TEXT,
      brief          TEXT NOT NULL,
      skill_md       TEXT,
      revision       INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'drafting' CHECK(status IN ('drafting','ready','failed')),
      run_id         TEXT,
      saved_skill_id TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `)

  // ── P0 foundations (SCHEMA_VERSION 8 — E-22/E-04 groundwork) ─────────────────
  // runs.cli_session_id: the CLI session id parsed from the run's stream-json
  // init line (the supervisor persists it; E-22 follow-up runs will `--resume`
  // it). projects.verify_recipe: operator-authored verify-recipe JSON (E-04;
  // the runner/badge land in P1). Both appended via guarded ALTERs so existing
  // DBs gain them; fresh installs get them from the DDL above. Pre-migration
  // rows read back NULL. hasTable guards keep migrate() safe against
  // old-schema fixtures predating either table (db-migration.test.ts).
  if (hasTable(d, 'runs')) {
    addColumn(d, 'runs', 'cli_session_id', 'TEXT')
  }
  if (hasTable(d, 'projects')) {
    addColumn(d, 'projects', 'verify_recipe', 'TEXT')
  }

  // ── P1 Trust Core (SCHEMA_VERSION 9 — E-01 review comments + E-04 verify
  // results). Both are NEW tables: CREATE TABLE IF NOT EXISTS covers fresh
  // installs (main DDL) AND migrated DBs (here). No ALTERs — idempotent by
  // construction. hasTable(runs) guard keeps migrate() safe against minimal
  // old-schema fixtures predating the runs table.
  if (hasTable(d, 'runs')) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS review_comments (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs(id),
        file       TEXT NOT NULL,
        line       INTEGER,
        side       TEXT NOT NULL DEFAULT 'new' CHECK(side IN ('old','new')),
        body       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','resolved')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_comments_run ON review_comments(run_id, created_at);
      CREATE TABLE IF NOT EXISTS verify_results (
        run_id       TEXT PRIMARY KEY REFERENCES runs(id),
        status       TEXT NOT NULL CHECK(status IN ('running','pass','fail','skipped','error')),
        reason       TEXT,
        commands     TEXT NOT NULL DEFAULT '[]',
        scope        TEXT,
        started_at   INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)
  }

  // ── P2 Human Gates (SCHEMA_VERSION 10 — E-02 plans, E-19 notifications, E-05
  // dismissal columns, E-06 auto-merge, E-02 tier default). New tables use
  // CREATE TABLE IF NOT EXISTS (fresh installs get them from the DDL above);
  // columns use guarded addColumn. reviewed_at backfills pre-existing done runs
  // ONLY when the column is freshly added — re-running this block must never
  // stamp runs that finished after v10 (they belong in the Inbox).
  if (hasTable(d, 'runs')) {
    const reviewedAtFresh = !hasColumn(d, 'runs', 'reviewed_at')
    addColumn(d, 'runs', 'reviewed_at', 'INTEGER')
    // Backfill reads ended_at/created_at — guard on their presence so migrate() is
    // safe against minimal old-schema fixtures that predate them (real runs tables
    // always carry both; degenerate fixtures have no done runs to backfill anyway).
    if (reviewedAtFresh && hasColumn(d, 'runs', 'ended_at') && hasColumn(d, 'runs', 'created_at')) {
      d.prepare(`UPDATE runs SET reviewed_at = COALESCE(ended_at, created_at) WHERE status = 'done' AND reviewed_at IS NULL`).run()
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS run_plans (
        run_id      TEXT PRIMARY KEY REFERENCES runs(id),
        plan        TEXT,
        raw         TEXT NOT NULL,
        edited      INTEGER NOT NULL DEFAULT 0,
        profile_id  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        approved_at INTEGER
      );
    `)
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      event_key  TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT,
      run_id     TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      read_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
    CREATE TABLE IF NOT EXISTS notification_rules (
      event_key TEXT PRIMARY KEY,
      inapp     INTEGER NOT NULL DEFAULT 1,
      browser   INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO notification_rules (event_key, inapp, browser) VALUES
      ('run_awaiting_input', 1, 1),
      ('run_awaiting_plan',  1, 1),
      ('run_review_ready',   1, 0),
      ('run_failed',         1, 0),
      ('verify_fail',        1, 0);
  `)
  if (hasTable(d, 'projects')) {
    addColumn(d, 'projects', 'auto_merge', 'INTEGER NOT NULL DEFAULT 0')
  }
  if (hasTable(d, 'agent_profiles')) {
    addColumn(d, 'agent_profiles', 'plan_gate', 'INTEGER NOT NULL DEFAULT 0')
  }
  if (hasTable(d, 'host_mcp_servers')) {
    addColumn(d, 'host_mcp_servers', 'inbox_dismissed_hash', 'TEXT')
  }

  // ── UI Simplification (SCHEMA_VERSION 11 — multi-thread K archive flag, operator
  // user_memories store, memory_saved notification rule, one-shot thread-title backfill).
  if (hasTable(d, 'k_threads')) {
    addColumn(d, 'k_threads', 'archived_at', 'INTEGER')
    // one-shot title backfill: NULL-titled threads take their first user turn (idempotent
    // — guarded on NULL). hasTable(k_thread_turns) guard keeps migrate() safe against
    // old-schema fixtures that predate the turns table (e.g. the cli_session_id test).
    if (hasTable(d, 'k_thread_turns')) {
      d.prepare(`
        UPDATE k_threads SET title = substr((
          SELECT t.text FROM k_thread_turns t
          WHERE t.thread_id = k_threads.id AND t.role = 'user'
          ORDER BY t.created_at ASC LIMIT 1), 1, 60)
        WHERE title IS NULL AND EXISTS (
          SELECT 1 FROM k_thread_turns t WHERE t.thread_id = k_threads.id AND t.role = 'user')
      `).run()
    }
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id               TEXT PRIMARY KEY,
      content          TEXT NOT NULL,
      source_thread_id TEXT REFERENCES k_threads(id) ON DELETE SET NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `)
  if (hasTable(d, 'notification_rules')) {
    d.exec(`INSERT OR IGNORE INTO notification_rules (event_key, inapp, browser) VALUES ('memory_saved', 1, 0);`)
  }

  // ── Phase 5 Autonomy (SCHEMA_VERSION 12) ──────────────────────────────────
  // E-14/E-15: proposal + backlog fields on work_items. `source` = the collector
  // that produced a proposal (NULL for normal items); `source_key` = the dedupe key.
  if (hasTable(d, 'work_items')) {
    addColumn(d, 'work_items', 'source', 'TEXT')
    addColumn(d, 'work_items', 'source_key', 'TEXT')
    // Partial-unique: at most one live work_item per source_key; NULLs unconstrained
    // so ordinary (non-proposal) items are unaffected. Dedupe is enforced in SQL.
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_source_key
              ON work_items(source_key) WHERE source_key IS NOT NULL`)
  }
  // E-18: self-healing retry lineage on runs.
  if (hasTable(d, 'runs')) {
    addColumn(d, 'runs', 'retry_of', 'TEXT REFERENCES runs(id)')
    addColumn(d, 'runs', 'retry_count', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(d, 'runs', 'failure_class', 'TEXT')
    d.exec(`CREATE INDEX IF NOT EXISTS idx_runs_retry_of ON runs(retry_of)`)
  }
  // E-17: per-project daily budget cap (NULL = no cap). Org cap lives in app_config.
  if (hasTable(d, 'projects')) {
    addColumn(d, 'projects', 'budget_daily_usd', 'REAL')
  }

  // ── Impressive Wave (SCHEMA_VERSION 13) ─────────────────────────────────────
  // D-117 artifact registry: owning project + provenance on artifacts, and the
  // slug-prefix backfill for rows minted by compileProjectBible/compileProjectUiDemo
  // before the column existed. Only ids still present in projects are stamped
  // (FK-safe under foreign_keys=ON); a slug for a deleted project stays NULL.
  if (hasTable(d, 'artifacts')) {
    addColumn(d, 'artifacts', 'project_id', 'TEXT REFERENCES projects(id)')
    addColumn(d, 'artifacts', 'origin', "TEXT NOT NULL DEFAULT 'compiled' CHECK(origin IN ('compiled','scanned'))")
    d.exec(`
      UPDATE artifacts SET project_id = (
        SELECT p.id FROM projects p WHERE artifacts.slug LIKE 'project-' || p.id || '-%'
      )
      WHERE project_id IS NULL AND slug LIKE 'project-%'
    `)
  }
  // P5-FU-5: eval failure reason (see the eval_results DDL comment above).
  if (hasTable(d, 'eval_results')) {
    addColumn(d, 'eval_results', 'failure_reason', 'TEXT')
  }

  // ── Pipeline Engine (SCHEMA_VERSION 14, D-119) ──────────────────────────────
  // Evolve workflow_definitions into a Zod-typed executable form (a nullable `spec`
  // JSON column — legacy rows lazily compile via namedWorkflowToPipeline). Guarded on
  // the table existing (minimal migration fixtures predate it, exactly like the
  // artifacts/eval_results steps above).
  if (hasTable(d, 'workflow_definitions')) {
    addColumn(d, 'workflow_definitions', 'spec', 'TEXT')
  }
  // runs.pipeline_stage_id: the owning pipeline stage back-ref AND the v14 SENTINEL (a
  // column the LAST migration creates — see SCHEMA_SENTINEL). runs is unconditionally
  // present (the top of this scan ALTERs it unguarded), so this stays unguarded too.
  addColumn(d, 'runs', 'pipeline_stage_id', 'TEXT')
  d.exec(`CREATE INDEX IF NOT EXISTS idx_runs_pipeline_stage ON runs(pipeline_stage_id)`)

  // ── Orchestration Program Phase 2 W0 (SCHEMA_VERSION 15, D-120) ─────────────
  // Bounded-loop fields for the executable-pipeline engine (design §8): a
  // per-stage re-entry counter and a per-edge iteration cap. hasTable guards
  // keep migrate() safe against pre-v14 fixtures that predate these tables.
  if (hasTable(d, 'pipeline_stages')) {
    addColumn(d, 'pipeline_stages', 'iteration', 'INTEGER NOT NULL DEFAULT 0')
  }
  if (hasTable(d, 'pipeline_edges')) {
    addColumn(d, 'pipeline_edges', 'max_iterations', 'INTEGER')
    // NB: the when_cond CHECK repair (adding 'loop') is NOT here — it must run even on an
    // already-v15 DB that migrate()'s version gate fast-paths past, so it lives in the
    // UNCONDITIONAL repairPipelineEdgesWhenCond(d) below, invoked after migrate(db).
  }
  // pipeline_runs.owner_profile_id: which orchestrator AgentProfile owns/oversees
  // this run (design §6.2 — the multi-pipeline visibility view groups runs by
  // this column). No FK — deleting a profile must not invalidate run history.
  if (hasTable(d, 'pipeline_runs')) {
    addColumn(d, 'pipeline_runs', 'owner_profile_id', 'TEXT')
  }
  // Triggers (design §7 — the W0 "routines schema" reconciliation): there is no
  // dedicated `routines` table. GET /api/routines (routes/routines.ts) projects
  // schedule-triggered `skills` rows (triggerType='schedule') into RoutineView —
  // the routine model IS the skills table. So the recommended §7 extension (an
  // optional pipeline target on the routine row) lands on `skills`, not a
  // literal `routines` table; a dedicated `pipeline_schedules` table is NOT
  // needed (the row carries a pipeline target cleanly). pipeline_def_id loosely
  // refs workflow_definitions.id — the confirmed pipeline-def store (design
  // §10: Phase 1 evolved workflow_definitions.spec to hold the executable
  // PipelineSpec; no separate pipeline_defs table exists) — mirroring
  // pipeline_runs.definition_id's loose-ref (no FK) convention. NULL = a plain
  // skill/workflow-skill routine (unchanged behavior).
  if (hasTable(d, 'skills')) {
    addColumn(d, 'skills', 'pipeline_def_id', 'TEXT')
  }

  // ── Continuous Agents W0 (SCHEMA_VERSION 16, D-122..D-127) ──────────────────
  // The sessions/conversations/domains column wave. The three NEW v16 tables
  // (domains, agent_sessions, agent_messages) live ONLY in the unconditional DDL
  // block above (brand-new tables -> CREATE-only; the sub_agent_defs /
  // pipeline_ledger v15 convention) — this section is the guarded COLUMN
  // evolution, plus the one-shot runs.kind backfill and the engineering-domain
  // seed/stamps below. Every FK these columns imply (k_threads.profile_id ->
  // agent_profiles, runs.session_id -> agent_sessions, *.domain_id -> domains) is
  // CODE-enforced, NOT declared: SQLite's ADD COLUMN cannot carry REFERENCES
  // alongside a non-NULL default, and the loose-ref posture matches
  // pipeline_runs.owner_profile_id (deleting a profile/domain must never
  // invalidate history). hasTable guards keep migrate() safe against minimal
  // old-schema fixtures predating each table.
  if (hasTable(d, 'k_threads')) {
    // Every conversation now belongs to a durable agent (D-123). Pre-v16 threads
    // were ALL K front-door conversations — exactly what the DEFAULT backfills.
    // last_read_at is the operator's per-thread read cursor (unread badges).
    addColumn(d, 'k_threads', 'profile_id', "TEXT NOT NULL DEFAULT 'k-secretary'")
    addColumn(d, 'k_threads', 'last_read_at', 'INTEGER')
  }
  if (hasTable(d, 'runs')) {
    // session_id: the owning agent_sessions row for a session-attached run
    // (D-122). kind: the chat-turn | job | pipeline-stage bookkeeping
    // discriminator (D-127) — 'job' is correct for every historical one-shot
    // dispatch; the flag-guarded backfill below re-stamps the two kinds that are
    // derivable from existing bookkeeping.
    addColumn(d, 'runs', 'session_id', 'TEXT')
    addColumn(d, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'job'")
  }
  if (hasTable(d, 'agent_profiles')) {
    // domain_id: which domain the profile works in (D-125). identity_overlay: the
    // L1.5 per-profile identity prompt layer (D-126); NULL = no overlay.
    addColumn(d, 'agent_profiles', 'domain_id', 'TEXT')
    addColumn(d, 'agent_profiles', 'identity_overlay', 'TEXT')
  }
  if (hasTable(d, 'workflow_definitions')) {
    // workflow_definitions IS the pipeline-def store (v14 put `spec` here);
    // domain_id attributes a definition to a domain for supervision (D-125).
    addColumn(d, 'workflow_definitions', 'domain_id', 'TEXT')
  }
  // pipeline_runs.domain_id: the run-attribution column the domain supervisor
  // groups by (D-125) — AND the v16 SENTINEL (a column the LAST migration in this
  // scan creates; see SCHEMA_SENTINEL). MUST remain the last v16 ALTER.
  if (hasTable(d, 'pipeline_runs')) {
    addColumn(d, 'pipeline_runs', 'domain_id', 'TEXT')
  }

  // One-shot runs.kind backfill (D-127) — flag-guarded (the MEM_BACKFILL idiom:
  // app_config is created unconditionally earlier in this scan). The two kinds
  // derivable from existing bookkeeping are stamped exactly ONCE, so a later full
  // re-scan (a poisoned-stamp heal) can never clobber an operator's or Lane A's
  // post-v16 re-classification: K front-door chat turns are the runs a
  // k-secretary 'user-message' agent_runs row points at; pipeline-stage runs are
  // the ones the v14 executor stamped pipeline_stage_id on. Everything else keeps
  // the 'job' default. Per-source hasTable/hasColumn guards keep the sub-steps
  // safe against minimal fixtures predating agent_runs / pipeline_stage_id.
  const RUNS_KIND_FLAG = 'mig_runs_kind_backfill'
  const runsKindDone = d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RUNS_KIND_FLAG)
  if (!runsKindDone && hasTable(d, 'runs') && hasColumn(d, 'runs', 'kind')) {
    if (
      hasTable(d, 'agent_runs') &&
      hasColumn(d, 'agent_runs', 'profile_id') &&
      hasColumn(d, 'agent_runs', 'trigger') &&
      hasColumn(d, 'agent_runs', 'run_id')
    ) {
      d.exec(`
        UPDATE runs SET kind = 'chat-turn' WHERE id IN (
          SELECT run_id FROM agent_runs
          WHERE profile_id = 'k-secretary' AND trigger = 'user-message' AND run_id IS NOT NULL
        )
      `)
    }
    if (hasColumn(d, 'runs', 'pipeline_stage_id')) {
      d.exec(`UPDATE runs SET kind = 'pipeline-stage' WHERE pipeline_stage_id IS NOT NULL`)
    }
    d.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RUNS_KIND_FLAG)
  }

  // Seeds (D-125): the engineering domain + its member stamps. INSERT OR IGNORE +
  // `WHERE domain_id IS NULL` keep every re-scan a no-op against operator edits
  // of the ROW VALUES (a re-scan re-covers only a stamp cleared back to NULL —
  // the documented default-membership semantic; mirrors the notification_rules
  // OR-IGNORE seed posture, deliberately NOT flag-guarded). Targets are EXACTLY
  // the seeded ids: the five discipline leads (profiles.ts SEED_PROFILES) and the
  // eight standard pipeline definitions (pipeline-seeds.ts PIPELINE_SEEDS) —
  // operator-created rows (uuid ids) never match. NB: on a FRESH install the two
  // stamps no-op here (the profile/def rows are seeded LATER, at bootstrap) and a
  // healthy DB runs no further full scan until the NEXT version bump — so freshly
  // installed leads/defs stay domain_id NULL until Lane C ships bootstrap-side
  // stamping (tracked in the program ledger). The W0 contract stamps UPGRADED
  // DBs, where the rows pre-exist. hasTable/hasColumn guards: fixtures predating
  // the carrier tables.
  if (hasTable(d, 'domains')) {
    d.prepare(`
      INSERT OR IGNORE INTO domains (id, name, description, manager_profile_id, created_at)
      VALUES ('engineering', 'Engineering', NULL, 'chief', ?)
    `).run(Date.now())
  }
  if (hasTable(d, 'agent_profiles') && hasColumn(d, 'agent_profiles', 'domain_id')) {
    d.exec(`
      UPDATE agent_profiles SET domain_id = 'engineering'
      WHERE domain_id IS NULL AND id IN
        ('lead-frontend','lead-backend','lead-systems','lead-security','lead-network')
    `)
  }
  if (hasTable(d, 'workflow_definitions') && hasColumn(d, 'workflow_definitions', 'domain_id')) {
    d.exec(`
      UPDATE workflow_definitions SET domain_id = 'engineering'
      WHERE domain_id IS NULL AND id IN
        ('code-wave','investigate','refactor','implementation-cycle',
         'deep-research','bug-triage','security-audit','quick-task')
    `)
  }
}

/**
 * UNCONDITIONAL, idempotent repair of the pipeline_edges `when_cond` CHECK (orch-p2 A.2 /
 * design §8). The Phase-1 CHECK predates the bounded-loop edge and rejects when_cond='loop';
 * SQLite can't ALTER a CHECK, so rebuild the table (the proven verification_reports / work_items /
 * skills idiom) — data / index / FK preserved. This must run OUTSIDE migrate()'s version gate: a
 * DB that W0 already stamped v15 carries the OLD CHECK yet fast-paths past migrateSlow, so a
 * gated repair would never reach it. Invoked AFTER migrate(db), so `max_iterations` (a migrateSlow
 * ALTER) is guaranteed present when copied. Idempotency guard: rebuild ONLY while the sqlite_master
 * DDL still lacks the 'loop' literal (the old CHECK) — a permanent no-op after the rebuild, and on
 * any fresh install whose CREATE TABLE already lists 'loop'.
 */
function repairPipelineEdgesWhenCond(d: Database.Database): void {
  if (!hasTable(d, 'pipeline_edges')) return
  const ddl = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_edges'`)
    .get() as { sql?: string } | undefined
  if (!(ddl?.sql != null && !/'loop'/.test(ddl.sql))) return
  d.pragma('foreign_keys = OFF')
  try {
    const rebuild = d.transaction(() => {
      // Race re-check INSIDE the lock (multi-process boot: main server + per-run stdio MCP
      // children each open the DB): a process that lost the race must no-op.
      const current = d
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_edges'`)
        .get() as { sql?: string } | undefined
      if (!(current?.sql != null && !/'loop'/.test(current.sql))) return
      d.exec(`
        CREATE TABLE pipeline_edges_new (
          id              TEXT PRIMARY KEY,
          pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
          from_stage_key  TEXT,
          to_stage_key    TEXT NOT NULL,
          handoff         TEXT NOT NULL CHECK(handoff IN ('share-tree','branch','merge')),
          when_cond       TEXT NOT NULL DEFAULT 'always'
                            CHECK(when_cond IN ('always','pass','fail','repair','loop')),
          max_iterations  INTEGER
        );
        INSERT INTO pipeline_edges_new (rowid, id, pipeline_run_id, from_stage_key,
          to_stage_key, handoff, when_cond, max_iterations)
        SELECT rowid, id, pipeline_run_id, from_stage_key,
          to_stage_key, handoff, when_cond, max_iterations
        FROM pipeline_edges;
        DROP TABLE pipeline_edges;
        ALTER TABLE pipeline_edges_new RENAME TO pipeline_edges;
        CREATE INDEX IF NOT EXISTS idx_pipeline_edges_to ON pipeline_edges(pipeline_run_id, to_stage_key);
      `)
    })
    rebuild.immediate()
  } finally {
    d.pragma('foreign_keys = ON')
  }
}

migrate(db)
repairPipelineEdgesWhenCond(db)

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

// Stamp the CLI session id parsed from the run's stream-json init line (P0 —
// E-22 follow-up groundwork). Plain overwrite (last-wins): the CLI emits the
// init line once per process, so a re-write within one run id can only carry
// the current session.
const setRunCliSessionId = db.prepare(`UPDATE runs SET cli_session_id = ? WHERE id = ?`)

// P2 E-05: stamp a run as review-acknowledged (approve / request-changes / inbox
// dismiss all funnel here). reviewed_at IS NULL guard = idempotent + stamp-once.
const markRunReviewed = db.prepare(`UPDATE runs SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL`)

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

export const runsDb = { insertRun, updateRunStatus, getRun, listRunsFiltered, clearRunWorktree, setRunCliSessionId, markRunReviewed }

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

// P1: a run's checkpoint events only (raw carries {sha,tree,ref,wave}) — the
// durable checkpoint-chain listing (worktrees are gone at terminal; events persist).
const listCheckpointEvents = db.prepare(
  `SELECT seq, ts, raw FROM events WHERE run_id = ? AND type = 'checkpoint' ORDER BY seq ASC`,
)

// Bounded, pre-filtered assistant-event scan (oldest→newest) — the lead report-back
// (chief-dispatch.ts::concatLeadAssistantText) reads only enough assistant text to fill
// its output cap, so a long lead run never materializes its whole event log.
const listAssistantEvents = db.prepare(`SELECT * FROM events WHERE run_id = ? AND type = 'assistant' ORDER BY seq ASC LIMIT ?`)

// Seq-windowed assistant text — the K front-door answer capture (k-thread.ts::
// captureAnswers) reads only the NEW assistant text per turn boundary (seq > the
// last captured boundary): no raw column, never a full-log scan of the run.
const listAssistantEventsAfterSeq = db.prepare(
  `SELECT seq, text FROM events WHERE run_id = ? AND seq > ? AND type = 'assistant' ORDER BY seq ASC`,
)

// The LAST non-empty assistant event for a run — the run's CONCLUSION (final assistant
// message), not its opening. Backs the lead report-back TAIL summary (F-075:
// chief-dispatch.ts / k-thread.ts) so a report-back reflects what the lead concluded,
// never the "I'll start by loading the workflow status tools…" prefix. Bounded to one row.
const latestAssistantEvent = db.prepare(
  `SELECT seq, text FROM events WHERE run_id = ? AND type = 'assistant' AND text IS NOT NULL AND length(text) > 0 ORDER BY seq DESC LIMIT 1`,
)

// P2 E-02: re-seed the in-memory seq counter on plan resume (a reboot cleared it;
// events INSERT OR IGNORE would silently drop colliding seqs otherwise).
const nextEventSeq = db.prepare(`SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE run_id = ?`)
// P2 E-05/E-19: SQL-only "has reviewable changes" predicate (checkpoint events).
const hasCheckpointEvents = db.prepare(`SELECT EXISTS(SELECT 1 FROM events WHERE run_id = ? AND type = 'checkpoint') AS n`)

// E-18: the failing run's error text — the ONLY place it lives is the `text` column
// of its latest type='error' event (supervisor.ts, `text: String(err)`); a clean
// non-zero exit persists NO such event (BLOCKER 4). Backs failure classification.
const latestErrorEvent = db.prepare(`SELECT text FROM events WHERE run_id = ? AND type = 'error' ORDER BY seq DESC LIMIT 1`)

export const eventsDb = { insertEvent, listEvents, listDelegateEvents, getEventRaw, listCheckpointEvents, listAssistantEvents, listAssistantEventsAfterSeq, latestAssistantEvent, nextEventSeq, hasCheckpointEvents, latestErrorEvent }

// ─── Review comment helpers (P1 E-01) ────────────────────────────────────────

const insertReviewComment = db.prepare(`
  INSERT INTO review_comments (id, run_id, file, line, side, body, status, created_at)
  VALUES (@id, @runId, @file, @line, @side, @body, @status, @createdAt)
`)
const listReviewComments = db.prepare(`SELECT * FROM review_comments WHERE run_id = ? ORDER BY created_at ASC`)
const getReviewComment = db.prepare(`SELECT * FROM review_comments WHERE id = ? AND run_id = ?`)
const updateReviewComment = db.prepare(`UPDATE review_comments SET body = @body, status = @status WHERE id = @id`)
const deleteReviewComment = db.prepare(`DELETE FROM review_comments WHERE id = ? AND run_id = ?`)
// Flip every draft to 'sent' when a fix run is dispatched (request-changes).
const markDraftCommentsSent = db.prepare(`UPDATE review_comments SET status = 'sent' WHERE run_id = ? AND status = 'draft'`)
// Flip ONE bundled draft to 'sent' — id-scoped, status-only, still-draft-guarded:
// never replays a body snapshot, so a PATCH landing during the fix-run dispatch
// await is not clobbered (and a mid-await resolve wins over the flip).
const markReviewCommentSent = db.prepare(`UPDATE review_comments SET status = 'sent' WHERE id = ? AND status = 'draft'`)

export const reviewCommentsDb = {
  insertReviewComment, listReviewComments, getReviewComment,
  updateReviewComment, deleteReviewComment, markDraftCommentsSent, markReviewCommentSent,
}

// ─── Verify result helpers (P1 E-04) ─────────────────────────────────────────

const upsertVerifyResult = db.prepare(`
  INSERT INTO verify_results (run_id, status, reason, commands, scope, started_at, completed_at)
  VALUES (@runId, @status, @reason, @commands, @scope, @startedAt, @completedAt)
  ON CONFLICT(run_id) DO UPDATE SET
    status = excluded.status, reason = excluded.reason, commands = excluded.commands,
    scope = excluded.scope, started_at = excluded.started_at, completed_at = excluded.completed_at
`)
const getVerifyResult = db.prepare(`SELECT * FROM verify_results WHERE run_id = ?`)

export const verifyResultsDb = { upsertVerifyResult, getVerifyResult }

// ─── Run plan helpers (P2 E-02) ───────────────────────────────────────────────

const insertRunPlan = db.prepare(`
  INSERT INTO run_plans (run_id, plan, raw, edited, profile_id, created_at, updated_at)
  VALUES (@runId, @plan, @raw, @edited, @profileId, @createdAt, @updatedAt)
`)
const getRunPlan = db.prepare(`SELECT * FROM run_plans WHERE run_id = ?`)
// Last-wins structured edit — always flips edited=1 (the approve continuation
// tells the agent its plan was revised).
const updateRunPlanDoc = db.prepare(
  `UPDATE run_plans SET plan = @plan, edited = 1, updated_at = @updatedAt WHERE run_id = @runId`,
)
const stampRunPlanApproved = db.prepare(`UPDATE run_plans SET approved_at = ? WHERE run_id = ?`)

export const runPlansDb = { insertRunPlan, getRunPlan, updateRunPlanDoc, stampRunPlanApproved }

// ─── Notification helpers (P2 E-19) ──────────────────────────────────────────

const insertNotification = db.prepare(`
  INSERT INTO notifications (id, event_key, title, body, run_id, project_id, created_at, read_at)
  VALUES (@id, @eventKey, @title, @body, @runId, @projectId, @createdAt, @readAt)
`)
const listNotifications = db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`)
const countUnreadNotifications = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`)
// read_at IS NULL guard makes mark-read idempotent (changes===0 on a re-read).
const markNotificationRead = db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`)
const markAllNotificationsRead = db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`)
const getNotificationRule = db.prepare(`SELECT * FROM notification_rules WHERE event_key = ?`)
const listNotificationRules = db.prepare(`SELECT * FROM notification_rules ORDER BY event_key`)
const upsertNotificationRule = db.prepare(`
  INSERT INTO notification_rules (event_key, inapp, browser) VALUES (@eventKey, @inapp, @browser)
  ON CONFLICT(event_key) DO UPDATE SET inapp = excluded.inapp, browser = excluded.browser
`)

export const notificationsDb = {
  insertNotification, listNotifications, countUnreadNotifications,
  markNotificationRead, markAllNotificationsRead,
  getNotificationRule, listNotificationRules, upsertNotificationRule,
}

// ─── Artifact helpers ─────────────────────────────────────────────────────────

const upsertArtifact = db.prepare(`
  INSERT INTO artifacts (slug, title, phase, status, tags, linked_run_id, updated_at, md, html_path, project_id)
  VALUES (@slug, @title, @phase, @status, @tags, @linkedRunId, @updatedAt, @md, @htmlPath, @projectId)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title,
    phase = excluded.phase,
    status = excluded.status,
    tags = excluded.tags,
    linked_run_id = excluded.linked_run_id,
    updated_at = excluded.updated_at,
    md = excluded.md,
    html_path = excluded.html_path,
    -- a projectId-less recompile of the same slug must not null an existing stamp (BE.5d)
    project_id = COALESCE(excluded.project_id, artifacts.project_id)
`)
// origin is deliberately ABSENT from upsertArtifact: inserts default to 'compiled'
// (the DDL DEFAULT), and conflicts (recompiles) never flip provenance.

const getArtifact = db.prepare(`SELECT * FROM artifacts WHERE slug = ?`)
const listArtifacts = db.prepare(`SELECT slug, title, phase, status, tags, updated_at, project_id, origin FROM artifacts ORDER BY updated_at DESC`)
const listArtifactsByProject = db.prepare(`SELECT slug, title, phase, status, tags, updated_at, project_id, origin FROM artifacts WHERE project_id = ? ORDER BY updated_at DESC`)

// D-117 scan-managed rows. The DO UPDATE WHERE clause is a second belt: a slug
// collision with a compiled row silently no-ops instead of flipping provenance
// (the scanner's backing-path check should prevent it ever firing).
const upsertScannedArtifact = db.prepare(`
  INSERT INTO artifacts (slug, title, phase, status, tags, linked_run_id, updated_at, md, html_path, project_id, origin)
  VALUES (@slug, @title, NULL, NULL, @tags, NULL, @updatedAt, @md, @htmlPath, @projectId, 'scanned')
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title, updated_at = excluded.updated_at,
    html_path = excluded.html_path, project_id = excluded.project_id
  WHERE artifacts.origin = 'scanned'
`)
const listScannedArtifacts = db.prepare(`
  SELECT slug, html_path FROM artifacts
  WHERE origin = 'scanned' AND ((@projectId IS NULL AND project_id IS NULL) OR project_id = @projectId)
`)
const deleteScannedArtifact = db.prepare(`DELETE FROM artifacts WHERE slug = ? AND origin = 'scanned'`)
const deleteArtifact = db.prepare(`DELETE FROM artifacts WHERE slug = ?`)
// Every path that already BACKS a row: explicit html_path sources. Rows served from
// the ARTIFACTS_DIR/<slug>.html fallback are covered by the scanner's slug check.
const listArtifactHtmlPaths = db.prepare(`SELECT slug, html_path FROM artifacts WHERE html_path IS NOT NULL`)

export const artifactsDb = {
  upsertArtifact, getArtifact, listArtifacts, listArtifactsByProject,
  upsertScannedArtifact, listScannedArtifacts, deleteScannedArtifact, deleteArtifact,
  listArtifactHtmlPaths,
}

// ─── Project helpers ─────────────────────────────────────────────────────────

const insertProject = db.prepare(`
  INSERT INTO projects (id, name, local_path, github_remote, workspace_managed, bible_dir, created_at)
  VALUES (@id, @name, @localPath, @githubRemote, @workspaceManaged, @bibleDir, @createdAt)
`)

// default_branch is set via a dedicated statement right after insert (keeps the
// widely-used insertProject param shape unchanged across ~40 call sites). NULL until
// set — callers then fall back to a heuristic (W4 follow-up).
const setProjectDefaultBranch = db.prepare(`UPDATE projects SET default_branch = ? WHERE id = ?`)

// P1 E-04: set/clear the operator verify recipe (route-validated JSON, or NULL).
const setProjectVerifyRecipe = db.prepare(`UPDATE projects SET verify_recipe = ? WHERE id = ?`)

// P2 E-06: per-project auto-merge toggle (default OFF).
const setProjectAutoMerge = db.prepare(`UPDATE projects SET auto_merge = ? WHERE id = ?`)

// Atomic registration (MEDIUM-1): the row insert + its detected default_branch write
// land together or not at all, so a crash between them can't strand a row with the
// branch lost. Mirrors persistReport's both-or-neither transaction.
const insertProjectWithDefaultBranch = db.transaction(
  (params: Record<string, unknown>, defaultBranch: string | null) => {
    insertProject.run(params)
    if (defaultBranch != null) setProjectDefaultBranch.run(defaultBranch, params.id as string)
  },
)

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
  `SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN ('running','queued','awaiting_input','awaiting_plan')`,
)

// Hard-delete a project and everything hanging off it. workflow_runs and
// project_graphs cascade automatically (ON DELETE CASCADE); but runs,
// verification_reports, a run's events, github_cache, and project-scoped
// work_items have NO cascade, so they're cleaned explicitly in FK-safe order
// inside one transaction. Deleting the runs first lets workflow_runs.run_id
// (ON DELETE SET NULL) resolve before the project row (and its workflow_runs)
// cascade away. (project_tasks used to cascade here too — the table was fully
// collapsed into work_items and dropped in P5.1d2b.)
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
const deleteProjectRunComments = db.prepare(
  `DELETE FROM review_comments WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`,
)
const deleteProjectVerifyResults = db.prepare(
  `DELETE FROM verify_results WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`,
)
const deleteProjectRunPlans = db.prepare(
  `DELETE FROM run_plans WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`,
)
const deleteProjectRuns = db.prepare(`DELETE FROM runs WHERE project_id = ?`)
const deleteProjectReports = db.prepare(`DELETE FROM verification_reports WHERE project_id = ?`)
const deleteProjectGithubCache = db.prepare(`DELETE FROM github_cache WHERE project_id = ?`)
// Project-scoped work_items (the collapsed project_tasks store, P5.1d2): project_id
// is a NO-ACTION FK (no ON DELETE cascade), so these rows must be removed before the
// project row or the delete throws a FK violation. Personal items (project_id NULL,
// the run-scoped kstore tickets) are untouched.
const deleteProjectWorkItems = db.prepare(`DELETE FROM work_items WHERE project_id = ?`)
// Project-scoped discovered MCP servers (D-070, host-discovery.ts): project_id is a
// NO-ACTION FK like work_items, so these rows must go before the project row or the
// delete throws. (Discovered project SKILLS are a deliberately loose ref — no FK —
// and degrade to status='missing' at the next rescan instead; see the skills DDL note.)
const deleteProjectHostMcpServers = db.prepare(`DELETE FROM host_mcp_servers WHERE project_id = ?`)
// v13 (D-117): artifacts.project_id is a plain NO-ACTION FK by contract — scanned
// rows (filesystem-discovered) are deleted outright; compiled rows (harness-authored,
// e.g. the bible) are kept but detached to project_id NULL so the row survives the
// project's removal instead of FK-failing the delete.
const deleteProjectScannedArtifacts = db.prepare(`DELETE FROM artifacts WHERE project_id = ? AND origin = 'scanned'`)
const clearProjectArtifactsProjectId = db.prepare(`UPDATE artifacts SET project_id = NULL WHERE project_id = ?`)
const deleteProjectRow = db.prepare(`DELETE FROM projects WHERE id = ?`)
// E-17: set/clear a project's daily budget cap (NULL = no cap).
const setProjectBudget = db.prepare(`UPDATE projects SET budget_daily_usd = ? WHERE id = ?`)
const deleteProject = db.transaction((id: string) => {
  deleteProjectRunPlans.run(id)      // P2: FK on runs(id) — before deleteProjectRuns
  deleteProjectRunComments.run(id)   // P1: FK on runs(id) — before deleteProjectRuns
  deleteProjectVerifyResults.run(id) // P1: same FK ordering
  deleteProjectRunEvents.run(id)
  deleteProjectRuns.run(id)
  deleteProjectReports.run(id)
  deleteProjectGithubCache.run(id)
  deleteProjectWorkItems.run(id) // project-scoped work_items: NO-ACTION FK, delete before the project row
  deleteProjectHostMcpServers.run(id) // project-scoped discovered MCP servers: same NO-ACTION FK pattern
  deleteProjectScannedArtifacts.run(id) // v13: scanned rows are project-owned filesystem mirrors — gone with the project
  clearProjectArtifactsProjectId.run(id) // v13: compiled rows (bible etc.) detach, not delete
  deleteProjectRow.run(id) // cascades workflow_runs + project_graphs (project_tasks is gone — dropped in P5.1d2b)
})

export const projectsDb = {
  insertProject,
  setProjectDefaultBranch,
  setProjectVerifyRecipe,
  setProjectAutoMerge,
  insertProjectWithDefaultBranch,
  updateProjectHealth,
  getProject,
  listProjects,
  countActiveProjectRuns,
  deleteProject,
  setProjectBudget,
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
    // null = insufficient signal (F-032 rework); older rows are always numeric.
    score: r.score == null ? null : Number(r.score),
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
// FIRST-CLASS project surface of the unified work_items store (P5.1d2b, D-026).
// No longer a compat shim over a frozen table — project_tasks was fully collapsed
// into work_items(scope='project') and dropped in migrate(). Statement member
// names keep the ProjectTask domain vocabulary because that is the HTTP/product
// concept the routes expose. Param names/positions are unchanged (except
// updateProjectTaskFromIssue, which now also binds @projectId — cross-project
// defense); each SELECT projects the EXACT old snake_case column set so
// rowToProjectTask and tests reading t.issue_number / t.completed_at keep working.
// run_id is stamped NULL (project-scoped, not run-scoped) and updated_at reuses
// created_at on insert (the old project_tasks store had no updated_at).
// better-sqlite3 binds named params strictly, so each statement references exactly
// the params its callers pass.

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

// Issue-sync lookup: a task already mirroring a given (project, issue#). The
// partial unique index idx_work_items_project_issue makes the pair single-row;
// ORDER BY newest-first + LIMIT 1 is the belt keeping this deterministic even if
// that index were ever absent — the SAME tiebreak as the migrate() dedupe's
// survivor rule (created_at DESC, rowid DESC), so both always pick the same row.
const getProjectTaskByIssue = db.prepare(`
  SELECT id, project_id, title, status, created_at, completed_at, issue_number, issue_url, issue_state
  FROM work_items WHERE project_id = ? AND issue_number = ? AND scope = 'project'
  ORDER BY created_at DESC, rowid DESC LIMIT 1
`)

// Reconcile an existing task with its upstream issue. status/completed_at are
// decided by the caller (sync mapping); title and issue metadata always refresh.
// project_id is bound as cross-project defense: id is the PK today, but an
// unbound project_id would let a caller-supplied foreign id update another
// project's row.
const updateProjectTaskFromIssue = db.prepare(`
  UPDATE work_items
  SET title = @title, issue_url = @issueUrl, issue_state = @issueState,
      status = @status, completed_at = @completedAt
  WHERE id = @id AND project_id = @projectId AND scope = 'project'
`)

export const projectWorkItemsDb = {
  insertProjectTask,
  listProjectTasks,
  updateProjectTaskStatus,
  getProjectTask,
  deleteProjectTask,
  getProjectTaskByIssue,
  updateProjectTaskFromIssue,
}

/** Map a project-scoped work_items DB row → the shared ProjectTask shape
 *  (snake_case → camelCase, values coerced to typed forms; nullable cols → null). The
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
  INSERT INTO workflow_runs (id, project_id, run_id, task_ids, mode, workflow_id, status, created_at, completed_at)
  VALUES (@id, @projectId, @runId, @taskIds, @mode, @workflowId, @status, @createdAt, @completedAt)
`)

const patchWorkflowRunId = db.prepare(`UPDATE workflow_runs SET run_id = ? WHERE id = ?`)

const updateWorkflowRunStatus = db.prepare(`
  UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?
`)

const getWorkflowRun = db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`)

const listWorkflowRunsByProject = db.prepare(`
  SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC
`)

// Cross-project newest-first list (bounded) — backs GET /api/workflows/runs, the
// Workflows run-picker's "which runs were workflow-dispatched?" identity source. LEFT
// JOINs workflow_definitions so each row carries the template's name (workflow_name)
// alongside its id (workflow_id) — a dropped/unknown definition simply yields NULL (F-074).
const listRecentWorkflowRuns = db.prepare(`
  SELECT wr.*, wd.name AS workflow_name
    FROM workflow_runs wr
    LEFT JOIN workflow_definitions wd ON wd.id = wr.workflow_id
   ORDER BY wr.created_at DESC LIMIT ?
`)

export const workflowRunsDb = {
  insertWorkflowRun,
  patchWorkflowRunId,
  updateWorkflowRunStatus,
  getWorkflowRun,
  listWorkflowRunsByProject,
  listRecentWorkflowRuns,
}

// ─── kstore: work-item helpers ───────────────────────────────────────────────
// Backs the kstore MCP work-item tools + the durable work-items HTTP surface.
// The store now spans FOUR scopes: 'run' (the EPHEMERAL run-scoped default —
// visible only to the creating run), 'personal'/'org' (the DURABLE operator-global
// store — persists across sessions + runs), and 'project' (the folded-in project
// task surface). The run-scoped fetch/list statements key on the EXPLICIT `scope =
// 'run'`: `run_id IS ?` alone is null-safe but a null owner would otherwise match
// backfilled project rows AND durable rows (both run_id NULL), so keying on 'run'
// isolates the ephemeral run view from the durable + project surfaces. Durable rows
// are read through the scope-keyed statements (NO run filter — operator-global).

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (id, run_id, title, body, status, scope, created_at, updated_at)
  VALUES (@id, @runId, @title, @body, @status, @scope, @createdAt, @updatedAt)
`)
const updateWorkItem = db.prepare(`
  UPDATE work_items SET title = @title, body = @body, status = @status, updated_at = @updatedAt
  WHERE id = @id
`)
// Durable-only delete (F-019): scope-guarded to 'personal'/'org' so the HTTP DELETE can
// never remove an ephemeral run-scoped ticket or a project row — same guard the durable
// read/PATCH statements use. `changes` (0 when no durable row matched) lets the route 404.
const deleteWorkItemDurable = db.prepare(`DELETE FROM work_items WHERE id = ? AND scope IN ('personal','org')`)
const getWorkItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`)
// Run-scoped fetch — `IS` is null-safe so a null owner (no/unknown run) only matches
// null-owner rows; `scope = 'run'` keeps the ephemeral run view isolated from the
// durable ('personal'/'org') + 'project' surfaces. One run can never read or mutate
// another run's ephemeral tickets.
const getWorkItemOwned = db.prepare(`SELECT * FROM work_items WHERE id = ? AND run_id IS ? AND scope = 'run'`)
const listWorkItemsByRun = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? AND scope = 'run' ORDER BY created_at DESC LIMIT ?`,
)
const listWorkItemsByRunStatus = db.prepare(
  `SELECT * FROM work_items WHERE run_id IS ? AND scope = 'run' AND status = ? ORDER BY created_at DESC LIMIT ?`,
)
// Durable operator-global reads (NO run filter). getWorkItemDurable resolves a
// 'personal'/'org' row from ANY run (durable items are updatable from any session);
// 'project' rows stay unreachable. The list statements back both the kstore
// scope='personal'|'org' path and the /api/k/work-items HTTP surface.
const getWorkItemDurable = db.prepare(`SELECT * FROM work_items WHERE id = ? AND scope IN ('personal','org')`)
const listWorkItemsByScope = db.prepare(
  `SELECT * FROM work_items WHERE scope = ? ORDER BY created_at DESC LIMIT ?`,
)
const listWorkItemsByScopeStatus = db.prepare(
  `SELECT * FROM work_items WHERE scope = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
)
const listDurableWorkItems = db.prepare(
  `SELECT * FROM work_items WHERE scope IN ('personal','org') ORDER BY created_at DESC LIMIT ?`,
)
const listDurableWorkItemsByStatus = db.prepare(
  `SELECT * FROM work_items WHERE scope IN ('personal','org') AND status = ? ORDER BY created_at DESC LIMIT ?`,
)

export const workItemsDb = {
  insertWorkItem,
  updateWorkItem,
  deleteWorkItemDurable,
  getWorkItem,
  getWorkItemOwned,
  listWorkItemsByRun,
  listWorkItemsByRunStatus,
  getWorkItemDurable,
  listWorkItemsByScope,
  listWorkItemsByScopeStatus,
  listDurableWorkItems,
  listDurableWorkItemsByStatus,
}

// ── E-14/E-15 proposals + backlog (org-scoped work_items) ────────────────────
const insertProposal = db.prepare(`
  INSERT INTO work_items (id, title, body, status, scope, project_id, source, source_key, created_at, updated_at)
  VALUES (@id, @title, @body, 'blocked', 'org', @projectId, @source, @sourceKey, @createdAt, @createdAt)
`)
// Blocked+sourced org items are UNAPPROVED proposals; joined to project name for the inbox.
const listProposals = db.prepare(`
  SELECT w.*, p.name AS project_name FROM work_items w
  LEFT JOIN projects p ON p.id = w.project_id
  WHERE w.scope = 'org' AND w.status = 'blocked' AND w.source IS NOT NULL
  ORDER BY w.created_at DESC LIMIT ?
`)
const getProposalBySourceKey = db.prepare(`SELECT * FROM work_items WHERE source_key = ?`)
const countOpenProposals = db.prepare(`
  SELECT COUNT(*) AS n FROM work_items WHERE scope='org' AND status='blocked' AND source IS NOT NULL
`)
// Approve: blocked → open (enters the backlog). changes===0 ⇒ not an approvable proposal ⇒ 404.
const approveProposal = db.prepare(`
  UPDATE work_items SET status='open', updated_at=@now
  WHERE id=@id AND scope='org' AND status='blocked' AND source IS NOT NULL
`)
const dismissProposal = db.prepare(`
  UPDATE work_items SET status='cancelled', updated_at=@now
  WHERE id=@id AND scope='org' AND status='blocked' AND source IS NOT NULL
`)
// P5-FU-3: re-surface a DISMISSED proposal whose signal recurred after the re-nag
// window. dismissed_at ≡ the cancelled row's updated_at (dismissProposal stamps it);
// last_seen ≡ the collector observing the candidate NOW. Guarded to cancelled+sourced
// org rows so approve/done stay sticky.
const renagDismissedProposal = db.prepare(`
  UPDATE work_items SET status='blocked', updated_at=@now
  WHERE source_key=@sourceKey AND scope='org' AND source IS NOT NULL
    AND status='cancelled' AND updated_at <= @cutoff
`)
// Backlog = open org items (approved proposals OR operator/agent-created org tickets).
const listOpenBacklog = db.prepare(`
  SELECT * FROM work_items WHERE scope='org' AND status='open' ORDER BY created_at ASC LIMIT ?
`)
// E-15 atomic claim (mirrors leadDispatchDb.claimLeadDispatch): open → in_progress.
const claimBacklogItem = db.prepare(`
  UPDATE work_items SET status='in_progress', updated_at=@now
  WHERE id=@id AND scope='org' AND status='open'
`)
// Record the dispatched run id onto an already-claimed item (a second claim would match
// 0 rows now that status='in_progress'; updateWorkItem cannot set run_id). Conductor MAJOR 2.
const setWorkItemRun = db.prepare(`UPDATE work_items SET run_id=@runId, updated_at=@now WHERE id=@id`)
export const proposalsDb = {
  insertProposal, listProposals, getProposalBySourceKey, countOpenProposals,
  approveProposal, dismissProposal, renagDismissedProposal, listOpenBacklog, claimBacklogItem, setWorkItemRun,
}

// ── E-17 measured spend (rolling window; NO forecasting) ─────────────────────
const orgSpendSince = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS spend FROM runs WHERE created_at >= ?`)
const projectSpendSince = db.prepare(
  `SELECT COALESCE(SUM(cost_usd),0) AS spend FROM runs WHERE project_id = ? AND created_at >= ?`)
export const budgetDb = { orgSpendSince, projectSpendSince }

// ── E-18 retry lineage ───────────────────────────────────────────────────────
const setRunRetry = db.prepare(`UPDATE runs SET retry_of=@retryOf, retry_count=@retryCount WHERE id=@id`)
const setRunFailureClass = db.prepare(`UPDATE runs SET failure_class=@failureClass WHERE id=@id`)
// (countRunsSince/countRetriesSince removed — zero callers; retry-metrics.ts owns the series SQL.)
export const retryDb = { setRunRetry, setRunFailureClass }

// ── E-16 routine measured cost (skill_runs has NO cost; JOIN to runs) — MAJOR 4 ──
// skill_runs (db.ts:261-269) columns: id, skillId, runId, triggeredBy, startedAt, completedAt, status.
const scheduleSkillRunCost = db.prepare(`
  SELECT sr.startedAt AS started_at, r.cost_usd AS cost_usd
  FROM skill_runs sr LEFT JOIN runs r ON r.id = sr.runId WHERE sr.skillId = ?
`)
export const routinesDb = { scheduleSkillRunCost }

// ─── kstore: agent-memory (lesson) helpers ───────────────────────────────────
// Backs lesson_propose / lesson_list. A proposed lesson lands 'pending'; the
// operator accepts/rejects out of band (memory layer A — no retrieval here).

const insertLesson = db.prepare(`
  INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at, profile_id)
  VALUES (@id, @runId, @lesson, @status, @createdAt, @reviewedAt, @profileId)
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

// F-072: on finalize, reconcile any lingering NON-terminal step (still 'pending' or
// 'in_progress') to 'blocked' so the checklist can't contradict the finalized
// (completed/failed) workflow_run — an unfinished step is marked blocked, never falsely
// 'done'. Scoped to one workflow_run; only touches the two non-terminal statuses.
const reconcileNonTerminalSteps = db.prepare(
  `UPDATE workflow_steps SET status = 'blocked', updated_at = @updatedAt
     WHERE workflow_run_id = @workflowRunId AND status IN ('pending','in_progress')`,
)

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
  reconcileNonTerminalSteps,
}

// ─── logistics working store helpers (P5.1a; operator-durable, A1) ────────────
// Backs the logistics MCP tools (notes / calendar events / reminders). The store is
// OPERATOR-DURABLE (single operator): reads + update-fetches are operator-global —
// notes/events/reminders persist across sessions + runs, so any session may list or
// mutate them. run_id is recorded on INSERT as PROVENANCE only (which run created the
// row), never as an access filter. The calendar-event statement CONSTS are
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
const listNotes = db.prepare(
  `SELECT * FROM logistics_notes ORDER BY created_at DESC LIMIT ?`,
)
const listNotesByDone = db.prepare(
  `SELECT * FROM logistics_notes WHERE done = ? ORDER BY created_at DESC LIMIT ?`,
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
// The from/to window is pushed INTO SQL (not filtered in JS after a LIMIT) so the
// LIMIT caps the WINDOWED set — a caller passing `from` can never silently miss an
// in-window event that sorts after `limit` earlier out-of-window rows. Operator-global
// (NO run filter).
const listLogisticsEvents = db.prepare(
  `SELECT * FROM logistics_events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC LIMIT ?`,
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
const listReminders = db.prepare(
  `SELECT * FROM logistics_reminders ORDER BY remind_at ASC LIMIT ?`,
)
const listRemindersByStatus = db.prepare(
  `SELECT * FROM logistics_reminders WHERE status = ? ORDER BY remind_at ASC LIMIT ?`,
)

export const logisticsDb = {
  // notes
  insertNote,
  updateNote,
  getNote,
  listNotes,
  listNotesByDone,
  // calendar events
  insertEvent: insertLogisticsEvent,
  updateEvent: updateLogisticsEvent,
  getEvent: getLogisticsEvent,
  listEvents: listLogisticsEvents,
  // reminders
  insertReminder,
  updateReminder,
  getReminder,
  listReminders,
  listRemindersByStatus,
}

// ─── management working store helpers (Chief org — P5.2a; durable reads, A1) ──
// Backs the mgmt MCP tools (assignments / reports). WRITES stay run-scoped — the
// null-safe `IS` ownership fetch means one run can never MUTATE another run's
// assignments (pick_workflow/scope_projects/report/dispatch keep their ownership
// guards). READS are DURABLE across Chief activations: `listRecentAssignments` and
// `listRecentReports` are cross-run operator/Chief reads (the assignment_list /
// report_list tools + the Chief org-status Objectives panel), so they are NOT
// run-scoped. `listReportsByRun` stays run-scoped (the K→Chief report-back).

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
// Cross-activation operator/Chief read (report_list tool) — NOT run-scoped by design:
// newest-first across all Chief activations, incl. reports filed back by dispatched
// leads. id DESC is the same deterministic same-ms tie-break as listReportsByRun.
const listRecentReports = db.prepare(
  `SELECT * FROM mgmt_reports ORDER BY created_at DESC, id DESC LIMIT ?`,
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
  listRecentReports,
}

// ─── Lead-dispatch intent queue (loop-b) ─────────────────────────────────────
// The child→main dispatch hand-off (see the lead_dispatches DDL above). `dispatch_lead`
// (mgmt.ts, in the ephemeral child) RECORDS a 'pending' intent; the MAIN-process relay
// (lead-dispatch-relay.ts) drains + claims + executes it. claimLeadDispatch is the atomic
// pending→dispatched CAS so an overlapping drain can never double-execute one intent.

const insertLeadDispatch = db.prepare(`
  INSERT INTO lead_dispatches (id, assignment_id, chief_run_id, lead_profile_id, lead, workflow_id, goal, status, lead_run_id, created_at, dispatched_at)
  VALUES (@id, @assignmentId, @chiefRunId, @leadProfileId, @lead, @workflowId, @goal, 'pending', NULL, @createdAt, NULL)
`)
const listPendingLeadDispatches = db.prepare(`SELECT * FROM lead_dispatches WHERE status = 'pending' ORDER BY created_at ASC`)
const getLeadDispatch = db.prepare(`SELECT * FROM lead_dispatches WHERE id = ?`)
// "Active" is DERIVED, not stored — lead_dispatches has no success-terminal status (the
// relay deliberately leaves a completed intent 'dispatched' forever), so the guards that
// consume this (mgmt dispatch_lead guard 2, the reassign route) must derive liveness:
//   'pending'    → always active (recorded, not yet claimed);
//   'dispatched' → active ONLY while genuinely in flight — lead_run_id still NULL (the
//                  claim-window/crash-orphan case, blocking fail-safe until the boot sweep
//                  supervisor.ts::reconcileOrphanedLeadDispatches marks it failed) OR its
//                  lead run is still live (LEFT JOIN runs, non-terminal status).
// A 'dispatched' intent whose run reached terminal is retired-by-derivation and does NOT
// block — without this, one successful dispatch would wedge the assignment permanently
// (no follow-up dispatch, no reassign — ever). Terminal set mirrors
// run-lifecycle.ts::TERMINAL_RUN_STATUSES (the reconcile sweeps use the same inline idiom).
const getActiveLeadDispatchByAssignment = db.prepare(`
  SELECT ld.* FROM lead_dispatches ld
    LEFT JOIN runs r ON r.id = ld.lead_run_id
    WHERE ld.assignment_id = ?
      AND (
        ld.status = 'pending'
        OR (ld.status = 'dispatched'
            AND (ld.lead_run_id IS NULL OR r.status NOT IN ('done','error','killed','interrupted')))
      )
    ORDER BY ld.created_at DESC LIMIT 1
`)
// Atomically claim a pending intent (pending→dispatched) so an overlapping drain can't double-execute it.
const claimLeadDispatch = db.prepare(`UPDATE lead_dispatches SET status = 'dispatched', dispatched_at = @dispatchedAt WHERE id = @id AND status = 'pending'`)
const setLeadDispatchRun = db.prepare(`UPDATE lead_dispatches SET lead_run_id = @leadRunId WHERE id = @id`)
const markLeadDispatchFailed = db.prepare(`UPDATE lead_dispatches SET status = 'failed', dispatched_at = @dispatchedAt WHERE id = @id AND status = 'dispatched'`)
export const leadDispatchDb = { insertLeadDispatch, listPendingLeadDispatches, getLeadDispatch, getActiveLeadDispatchByAssignment, claimLeadDispatch, setLeadDispatchRun, markLeadDispatchFailed }

// ─── Pipeline Engine helpers (D-119, SCHEMA_VERSION 14) ──────────────────────
// The executable-pipeline runtime ledger (pipeline_runs / pipeline_stages /
// pipeline_edges / pipeline_dispatches / hook_definitions). Stage + dispatch claims
// are atomic CAS (…→dispatched WHERE status='pending') so an overlapping scheduler
// drain can never double-dispatch — mirrors leadDispatchDb.claimLeadDispatch. The
// engine mutates STATUS rows only; the frozen definition lives in pipeline_stages.spec.

// pipeline_runs — one execution of a pipeline. owner_profile_id (orch-p2 INT fix I-1) is the
// delegating orchestrator's AgentProfile id when instantiatePipeline is reached via
// delegate_pipeline → pipeline-dispatch-relay; the operator's direct POST /api/pipelines/:id/run
// binds it NULL (honestly ungrouped — no delegating profile exists).
const insertPipelineRun = db.prepare(`
  INSERT INTO pipeline_runs (id, definition_id, project_id, title, cwd, base_commit, status, created_at, updated_at, completed_at, owner_profile_id)
  VALUES (@id, @definitionId, @projectId, @title, @cwd, @baseCommit, 'running', @createdAt, @updatedAt, NULL, @ownerProfileId)
`)
const getPipelineRun = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`)
const listRunningPipelines = db.prepare(`SELECT * FROM pipeline_runs WHERE status = 'running' ORDER BY created_at ASC`)
// status → completed|failed|cancelled; pass completedAt on a terminal transition (NULL keeps it running).
const updatePipelineStatus = db.prepare(`UPDATE pipeline_runs SET status = @status, updated_at = @updatedAt, completed_at = @completedAt WHERE id = @id`)

// pipeline_stages — the materialized stages the engine walks.
const insertStage = db.prepare(`
  INSERT INTO pipeline_stages (id, pipeline_run_id, stage_key, kind, profile_id, spec, status, run_id, base_commit, result_commit, exit_code, failure_class, retry_count, repair_stage_key, repairs_used, gate_resolved_by, gate_note, cost_usd, created_at, updated_at, started_at, completed_at)
  VALUES (@id, @pipelineRunId, @stageKey, @kind, @profileId, @spec, 'pending', NULL, @baseCommit, NULL, NULL, NULL, 0, @repairStageKey, 0, NULL, NULL, NULL, @createdAt, @updatedAt, NULL, NULL)
`)
const getStage = db.prepare(`SELECT * FROM pipeline_stages WHERE id = ?`)
// The pipeline-ownership probe the global self-heal subscriber uses to SKIP a pipeline
// stage's run (else every stage would retry twice — §10 mandatory guard).
const getStageByRunId = db.prepare(`SELECT * FROM pipeline_stages WHERE run_id = ?`)
const listStagesForPipeline = db.prepare(`SELECT * FROM pipeline_stages WHERE pipeline_run_id = ? ORDER BY created_at ASC`)
// Atomic pending→dispatched claim (changes===0 → another drain won the race).
const claimStage = db.prepare(`UPDATE pipeline_stages SET status = 'dispatched', updated_at = @updatedAt, started_at = @startedAt WHERE id = @id AND status = 'pending'`)
// Wire the dispatched run + its computed fork base and flip dispatched→running. run_id is
// written synchronously at dispatch so a reboot can reconcile the claim window (§10).
const setStageRun = db.prepare(`UPDATE pipeline_stages SET run_id = @runId, base_commit = @baseCommit, status = 'running', updated_at = @updatedAt WHERE id = @id`)
const markStagePassed = db.prepare(`UPDATE pipeline_stages SET status = 'passed', result_commit = @resultCommit, exit_code = @exitCode, cost_usd = @costUsd, updated_at = @updatedAt, completed_at = @completedAt WHERE id = @id`)
const markStageFailed = db.prepare(`UPDATE pipeline_stages SET status = 'failed', failure_class = @failureClass, exit_code = @exitCode, cost_usd = @costUsd, updated_at = @updatedAt, completed_at = @completedAt WHERE id = @id`)
const markStageAwaitingGate = db.prepare(`UPDATE pipeline_stages SET status = 'awaiting_gate', updated_at = @updatedAt WHERE id = @id`)
// Single-resolver gate CAS (A5): approve→passed / reject→failed, but ONLY while still parked
// (status='awaiting_gate') — changes===0 means it was already resolved (the HTTP layer 409s).
const resolveGateStage = db.prepare(`UPDATE pipeline_stages SET status = @next, gate_resolved_by = @by, gate_note = @note, completed_at = @now, updated_at = @now WHERE id = @id AND status = 'awaiting_gate'`)

// pipeline_edges — the materialized DAG (from_stage_key NULL = an entry edge).
const insertEdge = db.prepare(`
  INSERT INTO pipeline_edges (id, pipeline_run_id, from_stage_key, to_stage_key, handoff, when_cond)
  VALUES (@id, @pipelineRunId, @fromStageKey, @toStageKey, @handoff, @whenCond)
`)
const listEdges = db.prepare(`SELECT * FROM pipeline_edges WHERE pipeline_run_id = ?`)
// Ready-detection reads a target's incoming edges (a stage is ready iff every incoming
// edge's `from` stage is passed).
const listIncomingEdges = db.prepare(`SELECT * FROM pipeline_edges WHERE pipeline_run_id = @pipelineRunId AND to_stage_key = @toStageKey`)
// Dynamic gate insertion (A5): repoint every edge that TARGETED beforeStage so it now targets
// the freshly-inserted gate. The gate→beforeStage edge is inserted AFTER this runs, so it is
// never itself repointed (no gate→gate self-loop).
const repointEdgesTo = db.prepare(`UPDATE pipeline_edges SET to_stage_key = @gateKey WHERE pipeline_run_id = @pid AND to_stage_key = @beforeKey`)

// DAG ready-detection (Lane A / A3 + A5 fail-activation; orch-p2 A.2 loop exclusion). A `pending`
// stage is READY iff ANY of three disjuncts holds (the frozen A5 truth table):
//   • ENTRY          — it has no real NON-LOOP inbound edge; OR
//   • AND-JOIN       — it has ≥1 incoming when_cond IN ('always','pass') edge AND every such
//                      edge's `from` stage is passed; OR
//   • FAIL-ACTIVATION — it has ≥1 incoming when_cond='fail' edge whose `from` stage failed.
// A `when:'loop'` edge NEVER satisfies readiness (orch-p2 §8, the F1 discipline): it is excluded
// from the ENTRY probe below (so a loop TARGET whose only real inbound is a back-edge is still an
// entry) AND it is naturally excluded from the AND-JOIN / FAIL disjuncts (their when_cond filters
// list only 'always'/'pass'/'fail'). A `repair` edge likewise never activates readiness (deferred).
// Dead / untaken pending stages are flipped to 'skipped' by markSkips BEFORE this runs, so they
// never match here. The claim CAS (claimStage) still gates the dispatch, so an overlapping drain
// can't double-fire.
const listReadyStages = db.prepare(`
  SELECT s.* FROM pipeline_stages s
  WHERE s.pipeline_run_id = @pid AND s.status = 'pending'
    AND (
      NOT EXISTS (
        SELECT 1 FROM pipeline_edges e0
        WHERE e0.pipeline_run_id = s.pipeline_run_id AND e0.to_stage_key = s.stage_key
          AND e0.from_stage_key IS NOT NULL AND e0.when_cond != 'loop'
      )
      OR (
        EXISTS (
          SELECT 1 FROM pipeline_edges ep
          WHERE ep.pipeline_run_id = s.pipeline_run_id AND ep.to_stage_key = s.stage_key
            AND ep.from_stage_key IS NOT NULL AND ep.when_cond IN ('always','pass')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_edges e
          JOIN pipeline_stages fs ON fs.pipeline_run_id = e.pipeline_run_id AND fs.stage_key = e.from_stage_key
          WHERE e.pipeline_run_id = s.pipeline_run_id AND e.to_stage_key = s.stage_key
            AND e.from_stage_key IS NOT NULL AND e.when_cond IN ('always','pass')
            AND fs.status != 'passed'
        )
      )
      OR EXISTS (
        SELECT 1 FROM pipeline_edges ef
        JOIN pipeline_stages ffs ON ffs.pipeline_run_id = ef.pipeline_run_id AND ffs.stage_key = ef.from_stage_key
        WHERE ef.pipeline_run_id = s.pipeline_run_id AND ef.to_stage_key = s.stage_key
          AND ef.from_stage_key IS NOT NULL AND ef.when_cond = 'fail'
          AND ffs.status = 'failed'
      )
    )
`)

// pipeline_dispatches — the K/Chief→pipeline intent queue (mirrors lead_dispatches).
const insertPipelineDispatch = db.prepare(`
  INSERT INTO pipeline_dispatches (id, pipeline_id, k_run_id, goal, project_id, model, status, pipeline_run_id, created_at, dispatched_at)
  VALUES (@id, @pipelineId, @kRunId, @goal, @projectId, @model, 'pending', NULL, @createdAt, NULL)
`)
const listPendingPipelineDispatches = db.prepare(`SELECT * FROM pipeline_dispatches WHERE status = 'pending' ORDER BY created_at ASC`)
const getPipelineDispatch = db.prepare(`SELECT * FROM pipeline_dispatches WHERE id = ?`)
const claimPipelineDispatch = db.prepare(`UPDATE pipeline_dispatches SET status = 'dispatched', dispatched_at = @dispatchedAt WHERE id = @id AND status = 'pending'`)
const setPipelineDispatchRun = db.prepare(`UPDATE pipeline_dispatches SET pipeline_run_id = @pipelineRunId WHERE id = @id`)
const markPipelineDispatchFailed = db.prepare(`UPDATE pipeline_dispatches SET status = 'failed', dispatched_at = @dispatchedAt WHERE id = @id AND status = 'dispatched'`)

// workflow_definitions.spec — the executable-definition evolution (JSON PipelineSpec;
// NULL for a legacy row that lazily compiles via namedWorkflowToPipeline).
const setDefSpec = db.prepare(`UPDATE workflow_definitions SET spec = @spec WHERE id = @id`)
const getDefSpec = db.prepare(`SELECT spec FROM workflow_definitions WHERE id = ?`)

// hook_definitions — the run-internal hook registry.
const insertHook = db.prepare(`
  INSERT INTO hook_definitions (id, name, event, matcher, impl, timeout_sec, scope, project_id, source, trusted, enabled, created_at, updated_at)
  VALUES (@id, @name, @event, @matcher, @impl, @timeoutSec, @scope, @projectId, @source, @trusted, @enabled, @createdAt, @updatedAt)
`)
const listHooks = db.prepare(`SELECT * FROM hook_definitions ORDER BY created_at ASC`)
const getHook = db.prepare(`SELECT * FROM hook_definitions WHERE id = ?`)
const setHookTrusted = db.prepare(`UPDATE hook_definitions SET trusted = @trusted, updated_at = @updatedAt WHERE id = @id`)
const setHookEnabled = db.prepare(`UPDATE hook_definitions SET enabled = @enabled, updated_at = @updatedAt WHERE id = @id`)

export const pipelineDb = {
  // pipeline_runs
  insertPipelineRun, getPipelineRun, listRunningPipelines, updatePipelineStatus,
  // pipeline_stages
  insertStage, getStage, getStageByRunId, listStagesForPipeline, claimStage,
  setStageRun, markStagePassed, markStageFailed, markStageAwaitingGate, resolveGateStage,
  // pipeline_edges
  insertEdge, listEdges, listIncomingEdges, listReadyStages, repointEdgesTo,
  // pipeline_dispatches
  insertPipelineDispatch, listPendingPipelineDispatches, getPipelineDispatch,
  claimPipelineDispatch, setPipelineDispatchRun, markPipelineDispatchFailed,
  // workflow_definitions.spec
  setDefSpec, getDefSpec,
  // hook_definitions
  insertHook, listHooks, getHook, setHookTrusted, setHookEnabled,
}

// ─── Pipeline ledger helpers (orch-p2 W0, SCHEMA_VERSION 15, D-120 §6.1) ─────
// Append-only per-pipeline-run progress feed. seq is assigned atomically inside a
// single db.transaction (MAX(seq)+1 per pipeline_run_id, 1 for the first entry) so
// concurrent writers from different stages can't race the
// UNIQUE(pipeline_run_id, seq) constraint. detail is bound already-stringified (or
// null) at the call site, mirroring the agent_profiles JSON-column convention.

const getMaxLedgerSeq = db.prepare(`SELECT MAX(seq) AS maxSeq FROM pipeline_ledger WHERE pipeline_run_id = ?`)
const insertLedgerEntryRow = db.prepare(`
  INSERT INTO pipeline_ledger (id, pipeline_run_id, stage_key, seq, ts, kind, actor, goal, detail, cost)
  VALUES (@id, @pipelineRunId, @stageKey, @seq, @ts, @kind, @actor, @goal, @detail, @cost)
`)
const listLedgerByRun = db.prepare(`SELECT * FROM pipeline_ledger WHERE pipeline_run_id = ? ORDER BY seq ASC`)

type LedgerInsertParams = {
  id: string; pipelineRunId: string; stageKey: string | null; ts: number; kind: string
  actor: string | null; goal: string | null; detail: string | null; cost: number | null
}
// Returns the assigned seq — callers stamp it into the pipeline_update WS delta's ledgerSeq cursor.
const insertLedgerEntry = db.transaction((p: LedgerInsertParams): number => {
  const row = getMaxLedgerSeq.get(p.pipelineRunId) as { maxSeq: number | null }
  const seq = (row.maxSeq ?? 0) + 1
  insertLedgerEntryRow.run({ ...p, seq })
  return seq
})

export const pipelineLedgerDb = { insertLedgerEntry, listLedgerByRun }

/** Map a pipeline_ledger DB row → the canonical PipelineLedgerEntry shape (@k/shared).
 *  snake_case → camelCase; detail parses from JSON TEXT (null-safe: garbled/absent
 *  JSON leaves `detail` undefined rather than throwing, mirroring rowToReport's
 *  score_breakdown handling). */
export function rowToPipelineLedgerEntry(r: Record<string, unknown>): PipelineLedgerEntry {
  const entry: PipelineLedgerEntry = {
    id: String(r.id),
    pipelineRunId: String(r.pipeline_run_id),
    stageKey: r.stage_key == null ? null : String(r.stage_key),
    seq: Number(r.seq),
    ts: Number(r.ts),
    kind: r.kind as PipelineLedgerEntry['kind'],
    actor: r.actor == null ? null : String(r.actor),
    goal: r.goal == null ? null : String(r.goal),
    cost: r.cost == null ? null : Number(r.cost),
  }
  if (r.detail != null) {
    try {
      entry.detail = JSON.parse(String(r.detail))
    } catch {
      /* leave detail undefined on garbled JSON */
    }
  }
  return entry
}

// ─── Sub Agent helpers (orch-p2 W0, SCHEMA_VERSION 15, D-120 §3) ─────────────
// The operator-editable worker-bee registry an `agent` StageDef's `subagentType`
// resolves against (K-native workers resolve from agent-config/agents/*.md at read
// time instead — not persisted here). JSON columns (allowed_tools/mcp_servers/
// skills) are bound already-stringified at the call site, mirroring agent_profiles.
// `name` is UNIQUE.

const insertSubAgent = db.prepare(`
  INSERT INTO sub_agent_defs (id, name, role, model, allowed_tools, mcp_servers, skills, prompt, source, enabled, created_at, updated_at)
  VALUES (@id, @name, @role, @model, @allowedTools, @mcpServers, @skills, @prompt, @source, @enabled, @createdAt, @updatedAt)
`)
const getSubAgent = db.prepare(`SELECT * FROM sub_agent_defs WHERE id = ?`)
const getSubAgentByName = db.prepare(`SELECT * FROM sub_agent_defs WHERE name = ?`)
const listSubAgents = db.prepare(`SELECT * FROM sub_agent_defs ORDER BY created_at ASC`)
const updateSubAgent = db.prepare(`
  UPDATE sub_agent_defs
  SET name = @name, role = @role, model = @model, allowed_tools = @allowedTools,
      mcp_servers = @mcpServers, skills = @skills, prompt = @prompt, enabled = @enabled,
      updated_at = @updatedAt
  WHERE id = @id
`)
const deleteSubAgent = db.prepare(`DELETE FROM sub_agent_defs WHERE id = ?`)

export const subAgentDb = {
  insertSubAgent, getSubAgent, getSubAgentByName, listSubAgents, updateSubAgent, deleteSubAgent,
}

/** Map a sub_agent_defs DB row → the canonical SubAgentDef shape (@k/shared).
 *  snake_case → camelCase; allowed_tools/mcp_servers/skills parse from JSON TEXT to
 *  string[] (null-safe: garbled/absent JSON degrades to [] rather than throwing,
 *  mirroring rowToAgentProfile); enabled INTEGER -> boolean. */
export function rowToSubAgentDef(r: Record<string, unknown>): SubAgentDef {
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
    role: String(r.role),
    model: r.model == null ? null : String(r.model),
    allowedTools: parseStrArr(r.allowed_tools),
    mcpServers: parseStrArr(r.mcp_servers),
    skills: parseStrArr(r.skills),
    prompt: String(r.prompt),
    source: r.source as SubAgentDef['source'],
    enabled: r.enabled === 1,
  }
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

// qualified_key is NOT NULL UNIQUE (SCHEMA_VERSION 7, D-069): every insert must
// bind it. K-native (automation-registry) rows use the BARE NAME as their
// qualified key — callers pass @qualifiedKey = name — which preserves the old
// per-name uniqueness for k-native skills. source_kind defaults to 'k'.
const insertSkill = db.prepare(`
  INSERT INTO skills (id, name, description, type, source, triggerType, schedule, eventTrigger, enabled, createdAt, qualified_key)
  VALUES (@id, @name, @description, @type, @source, @triggerType, @schedule, @eventTrigger, @enabled, @createdAt, @qualifiedKey)
`)

// AUTOMATION-REGISTRY scope (D-069 back-compat lock): the pre-v7 surfaces —
// GET /api/skills, the POST/PATCH name-collision pre-checks, seedBuiltinSkills —
// see ONLY k-native rows. Post-v7, `name` is no longer unique across SOURCES
// (a k-native `foo` and a discovered `user:foo` may coexist; qualified_key is
// the real key), so an unscoped name lookup would 409 a legitimate k-native
// create / suppress a builtin re-seed the moment Lane-A discovery inserts host
// rows. Filtering on source_kind = 'k' is a no-op today (every existing row is
// 'k') and keeps the automation registry byte-compatible afterward. Catalog
// reads get their own statements in Lane A.
const listSkills = db.prepare(`SELECT * FROM skills WHERE source_kind = 'k' ORDER BY createdAt DESC`)

const getSkill = db.prepare(`SELECT * FROM skills WHERE id = ?`)

const getSkillByName = db.prepare(`SELECT * FROM skills WHERE name = ? AND source_kind = 'k'`)

const updateSkillEnabled = db.prepare(`UPDATE skills SET enabled = ? WHERE id = ?`)

const updateSkillSchedule = db.prepare(`UPDATE skills SET schedule = ?, eventTrigger = ? WHERE id = ?`)

// Task B.3: the routine→pipeline target. NULL clears it (the routine reverts to firing as
// a plain skill run). Loose ref (no FK, mirrors the v15 ALTER's own note) — validated at the
// route (an unknown workflow_definitions id 400s) rather than the schema.
const updateSkillPipelineDefId = db.prepare(`UPDATE skills SET pipeline_def_id = ? WHERE id = ?`)

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
  updateSkillPipelineDefId,
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
  INSERT INTO eval_results (id, evalRunId, systemId, caseId, model, variant, detPass, detScore, formatScore, judgeOverall, judgeVerdict, refusalCorrect, costUsd, ms, numTurns, error, failure_reason, raw, createdAt)
  VALUES (@id, @evalRunId, @systemId, @caseId, @model, @variant, @detPass, @detScore, @formatScore, @judgeOverall, @judgeVerdict, @refusalCorrect, @costUsd, @ms, @numTurns, @error, @failureReason, @raw, @createdAt)
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

// ─── Operator memory helpers (UI Simplification, SCHEMA_VERSION 11) ─────────
// The user_memories store — saved directly (operator or K's memory_save tool),
// no accept/reject gate (contrast Lesson, agent memory layer A).

export const memoriesDb = {
  insertMemory: db.prepare(`
    INSERT INTO user_memories (id, content, source_thread_id, created_at, updated_at)
    VALUES (@id, @content, @sourceThreadId, @createdAt, @updatedAt)`),
  // rowid DESC tiebreak: two rows written in the same millisecond would otherwise
  // order nondeterministically (latest-inserted wins ties).
  listMemories: db.prepare(`SELECT * FROM user_memories ORDER BY updated_at DESC, rowid DESC`),
  listRecentMemories: db.prepare(`SELECT * FROM user_memories ORDER BY updated_at DESC, rowid DESC LIMIT ?`),
  getMemory: db.prepare(`SELECT * FROM user_memories WHERE id = ?`),
  updateMemory: db.prepare(`UPDATE user_memories SET content = @content, updated_at = @updatedAt WHERE id = @id`),
  deleteMemory: db.prepare(`DELETE FROM user_memories WHERE id = ?`),
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

// P2 E-02: tier default — dispatches resolved through this profile plan-gate by default.
const setProfilePlanGate = db.prepare(`UPDATE agent_profiles SET plan_gate = ? WHERE id = ?`)

export const agentProfilesDb = {
  insertProfile,
  getProfileRow,
  getProfileByNameRow,
  listProfileRows,
  updateProfileRow,
  setProfilePlanGate,
}

/** Map an agent_profiles DB row → the canonical AgentProfile shape (@k/shared).
 *  snake→camel; the `charter` column feeds the type's `charter` (charter-asset
 *  basename); the JSON columns parse to string[] (null-safe: garbled/absent JSON
 *  degrades to [] rather than throwing, mirroring rowToReport).
 *  default_model: the column stays `TEXT NOT NULL` (SQLite can't drop NOT NULL
 *  without a foreign-key-laden table rebuild); '' is the storage encoding of
 *  "no override — use the runtime Claude default", surfaced as null at the app
 *  boundary. */
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
    defaultModel: r.default_model == null || r.default_model === '' ? null : String(r.default_model),
    allowedTools: parseStrArr(r.allowed_tools),
    mcpServers: parseStrArr(r.mcp_servers),
    skills: parseStrArr(r.skills),
    planGate: r.plan_gate === 1 ? true : undefined,
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
// Self-wake guard + org-relevance filter: which profile owns the activation that
// produced this run_id, and how was it triggered? (chief-wake.ts skips its own runs
// and wakes only on lead/delegation terminals — a run with NO row never wakes.)
const getAgentRunProfileByRunId = db.prepare(
  `SELECT profile_id, trigger FROM agent_runs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
)
// Count a profile's activations for a given trigger — the whole-org tree (loop-b2) reads
// the chief profile's 'delegation' activations as the K→Chief delegation-edge count (every
// such chief run is one K hand-up: delegateToChief is the only path that activates the Chief
// with trigger='delegation'; autonomous wakes use schedule/event). 'failed' rows are
// EXCLUDED — note that status covers BOTH a dispatch that never spawned AND a delegation
// whose run activated but ended error/killed/interrupted (deriveAgentRunStatus maps every
// non-done terminal to 'failed') — so this deliberately counts SUCCESSFUL hand-ups
// (running/completed), a documented undercount of raw attempts. Cheap COUNT, no table.
const countAgentRunsByProfileAndTrigger = db.prepare(
  `SELECT COUNT(*) AS n FROM agent_runs WHERE profile_id = ? AND trigger = ? AND status != 'failed'`,
)
// Rolling-window variant — the chief-wake rate breaker counts the Chief's recent
// 'event' activations (created_at > now - 1h) against chief_wake_max_per_hour.
const countRecentAgentRunsByProfileAndTrigger = db.prepare(
  `SELECT COUNT(*) AS n FROM agent_runs WHERE profile_id = ? AND trigger = ? AND created_at > ?`,
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
  countAgentRunsByProfileAndTrigger,
  countRecentAgentRunsByProfileAndTrigger,
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
// The stable CLI session id for a thread's K asks (W7a). Read to decide first-ask
// (--session-id) vs resume (--resume); written ONCE on the first ask's successful
// terminal. The `IS NULL` guard makes the write idempotent — a resume ask never
// re-stamps it, and a rare concurrent first-ask can't clobber the winner's id.
const getThreadCliSessionId = db.prepare(`SELECT cli_session_id FROM k_threads WHERE id = ?`)
const setThreadCliSessionId = db.prepare(
  `UPDATE k_threads SET cli_session_id = ?, updated_at = ? WHERE id = ? AND cli_session_id IS NULL`,
)

const insertTurn = db.prepare(`
  INSERT INTO k_thread_turns (id, thread_id, role, text, run_id, created_at)
  VALUES (@id, @threadId, @role, @text, @runId, @createdAt)
`)
const getTurn = db.prepare(`SELECT * FROM k_thread_turns WHERE id = ?`)
const patchTurnRunId = db.prepare(`UPDATE k_thread_turns SET run_id = ? WHERE id = ?`)
const listTurns = db.prepare(`SELECT * FROM k_thread_turns WHERE thread_id = ? ORDER BY created_at ASC, id ASC`)
// F-060 undo: remove every turn a killed/undone run appended (the dangling `user` ask
// with no reply, plus any partial `k` turn), so an undone message is never replayed
// into a later seed. And clear a thread stranded pointing at that just-killed run.
const deleteTurnsByRunId = db.prepare(`DELETE FROM k_thread_turns WHERE run_id = ?`)
const clearThreadActiveRunByRunId = db.prepare(
  `UPDATE k_threads SET active_run_id = NULL, status = 'idle', updated_at = ? WHERE active_run_id = ?`,
)
// F-060 backstop: is there still a live `user` ask turn linked to this run? A `k` reply
// for a run whose `user` turn was removed (undone) would be orphaned — so this gates the
// reply-append paths (captureAnswers / reportDelegationBack) against a late flush from a
// killed-then-undone run resurrecting a reply with no matching ask.
const hasUserTurnForRun = db.prepare(
  `SELECT 1 FROM k_thread_turns WHERE run_id = ? AND role = 'user' LIMIT 1`,
)
// Resolve the K thread that DELEGATED a given run (loop-b2 Chief→K continuation). The
// K→Chief link is derivable with NO new table: delegateToChief patches the Chief run id
// onto the operator's user turn (and its ack turn), so a k_thread_turns row whose run_id =
// the Chief run id identifies the delegating thread. A Chief run that woke AUTONOMOUSLY
// (chief-wake) never touches k_thread_turns → this returns no row → no K continuation.
const getThreadIdByTurnRunId = db.prepare(
  `SELECT thread_id FROM k_thread_turns WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
)

// ── UI Simplification (multi-thread K, SCHEMA_VERSION 11) — thread list/rename/
// archive/delete + the active-run reverse lookup a resumed run's thread needs.
const listThreads = db.prepare(`
  SELECT th.*,
    (SELECT t.text FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS snippet,
    (SELECT t.created_at FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_at
  FROM k_threads th ORDER BY th.updated_at DESC`)
const setThreadTitle = db.prepare(`UPDATE k_threads SET title = ?, updated_at = ? WHERE id = ?`)
const setThreadArchived = db.prepare(`UPDATE k_threads SET archived_at = ?, updated_at = ? WHERE id = ?`)
// Visibility invariant: a thread receiving new activity must be visible in the non-archived
// list. Cleared at the appendTurn choke point so a thread archived mid-run/delegation resurfaces
// when K's reply lands. Guarded (WHERE archived_at IS NOT NULL) so a normal non-archived append
// is a no-op — no spurious updated_at bump / list reorder on the common path.
const clearThreadArchivedOnActivity = db.prepare(
  `UPDATE k_threads SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL`,
)
const deleteThread = db.prepare(`DELETE FROM k_threads WHERE id = ?`)
const threadByActiveRun = db.prepare(`SELECT * FROM k_threads WHERE active_run_id = ?`)

// ── Continuous Agents W0 (SCHEMA_VERSION 16, D-123) — conversations-for-all.
// The SAME shape as listThreads (snippet + last_turn_at subselects, updated_at
// DESC) scoped to one owning profile: the per-agent conversation list.
const listByProfile = db.prepare(`
  SELECT th.*,
    (SELECT t.text FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS snippet,
    (SELECT t.created_at FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_at
  FROM k_threads th WHERE th.profile_id = ? ORDER BY th.updated_at DESC`)
// Stamp the operator's read cursor (unread = turns newer than last_read_at).
// Deliberately does NOT bump updated_at — READING a thread must not reorder the
// conversation list the way real activity does.
const setLastReadAt = db.prepare(`UPDATE k_threads SET last_read_at = ? WHERE id = ?`)

export const kThreadsDb = {
  insertThread,
  getThread,
  updateThreadActiveRun,
  updateThreadStatus,
  getThreadCliSessionId,
  setThreadCliSessionId,
  insertTurn,
  getTurn,
  patchTurnRunId,
  listTurns,
  deleteTurnsByRunId,
  clearThreadActiveRunByRunId,
  hasUserTurnForRun,
  getThreadIdByTurnRunId,
  listThreads,
  setThreadTitle,
  setThreadArchived,
  clearThreadArchivedOnActivity,
  deleteThread,
  threadByActiveRun,
  // Continuous Agents W0 (SCHEMA_VERSION 16): per-profile conversations
  listByProfile,
  setLastReadAt,
}

// ─── Domains (Continuous Agents W0, SCHEMA_VERSION 16, D-125) ────────────────
// The domain registry rows the manager/supervision layer (Lane C) reads. Plain
// snake_case rows out (no mapper here — domains.ts owns the canonical shape,
// mirroring how rowToNamedWorkflow lives beside workflowDefsDb). `update` takes
// the full mutable set — callers pass current values for fields they aren't
// changing (the updateSkillContent convention). created_at/id are immutable.

const insertDomain = db.prepare(`
  INSERT INTO domains (id, name, description, manager_profile_id, created_at)
  VALUES (@id, @name, @description, @managerProfileId, @createdAt)
`)
const getDomain = db.prepare(`SELECT * FROM domains WHERE id = ?`)
const listDomains = db.prepare(`SELECT * FROM domains ORDER BY created_at ASC, id ASC`)
const updateDomain = db.prepare(`
  UPDATE domains SET name = @name, description = @description, manager_profile_id = @managerProfileId
  WHERE id = @id
`)

export const domainsDb = { get: getDomain, list: listDomains, create: insertDomain, update: updateDomain }

// ─── Agent sessions (Continuous Agents W0, SCHEMA_VERSION 16, D-122) ─────────
// The hybrid warm/resumable session records agent-sessions.ts (Lane A) drives.
// UNIQUE(profile_id, thread_id) makes upsert the ONLY insert path: the first call
// creates the row; a later call for the same (profile, thread) REFRESHES the
// mutable fields while keeping the original id + created_at — session identity is
// the PAIR, not the row id. Timestamps are caller-passed (the kThreadsDb
// convention) — no hidden Date.now() in the store.

const upsertSessionRow = db.prepare(`
  INSERT INTO agent_sessions (id, profile_id, thread_id, cli_session_id, home_dir, state, context_tokens, last_activity_at, created_at, updated_at)
  VALUES (@id, @profileId, @threadId, @cliSessionId, @homeDir, @state, @contextTokens, @lastActivityAt, @createdAt, @updatedAt)
  ON CONFLICT(profile_id, thread_id) DO UPDATE SET
    cli_session_id   = excluded.cli_session_id,
    home_dir         = excluded.home_dir,
    state            = excluded.state,
    context_tokens   = excluded.context_tokens,
    last_activity_at = excluded.last_activity_at,
    updated_at       = excluded.updated_at
`)
const getSessionByProfileThread = db.prepare(`SELECT * FROM agent_sessions WHERE profile_id = ? AND thread_id = ?`)
const getSession = db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`)
// state + updated_at: the promote/demote transitions (live -> resumable -> stale).
const setSessionState = db.prepare(`UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?`)
// Plain overwrite (last-wins): a re-seeded session gets a NEW CLI session id —
// unlike k_threads.cli_session_id there is no write-once contract here.
const setSessionCliSessionId = db.prepare(`UPDATE agent_sessions SET cli_session_id = ?, updated_at = ? WHERE id = ?`)
// Ordered on updated_at (NOT NULL) rather than last_activity_at (nullable) so a
// never-touched session still sorts deterministically.
const listSessionsByState = db.prepare(`SELECT * FROM agent_sessions WHERE state = ? ORDER BY updated_at DESC`)
const touchSessionRow = db.prepare(`UPDATE agent_sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)

type SessionUpsertParams = {
  id: string; profileId: string; threadId: string; cliSessionId: string | null
  homeDir: string; state: string; contextTokens: number | null; lastActivityAt: number | null
  createdAt: number; updatedAt: number
}
/** Insert-or-refresh on UNIQUE(profile_id, thread_id); returns the current row
 *  (the pre-existing id/created_at on the refresh path). */
function upsertSession(p: SessionUpsertParams): Record<string, unknown> {
  upsertSessionRow.run(p)
  return getSessionByProfileThread.get(p.profileId, p.threadId) as Record<string, unknown>
}
/** Bump both activity timestamps to `ts` (a delivered message / observed turn). */
function touchSession(id: string, ts: number): void {
  touchSessionRow.run(ts, ts, id)
}

export const agentSessionsDb = {
  getByProfileThread: getSessionByProfileThread,
  get: getSession,
  upsert: upsertSession,
  setState: setSessionState,
  setCliSessionId: setSessionCliSessionId,
  touch: touchSession,
  listByState: listSessionsByState,
}

// ─── Agent mailbox (Continuous Agents W0, SCHEMA_VERSION 16, D-124) ──────────
// Queue rows only — DELIVERY policy (state-routed, urgent-first) is the relay's
// (message-relay.ts, Lane B), which is why the store deliberately has no priority
// ordering: listQueuedForProfile is plain created_at ASC (id ASC tiebreak, the
// listTurns convention). A new message is by definition queued — status and
// delivered_at take their DDL defaults on insert.

const insertMessage = db.prepare(`
  INSERT INTO agent_messages (id, to_profile_id, to_thread_id, from_kind, from_profile_id, body, priority, provenance_run_id, created_at)
  VALUES (@id, @toProfileId, @toThreadId, @fromKind, @fromProfileId, @body, @priority, @provenanceRunId, @createdAt)
`)
const listQueuedForProfile = db.prepare(`
  SELECT * FROM agent_messages WHERE to_profile_id = ? AND status = 'queued'
  ORDER BY created_at ASC, id ASC
`)
// delivered_at is stamped on DELIVERY only — a failed message keeps it NULL.
const markMessageDelivered = db.prepare(`UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?`)
const markMessageFailed = db.prepare(`UPDATE agent_messages SET status = 'failed' WHERE id = ?`)
const countQueuedRow = db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_profile_id = ? AND status = 'queued'`)
/** How many messages are still queued for a profile (the unread-badge count). */
function countQueued(profileId: string): number {
  return Number((countQueuedRow.get(profileId) as { n: number }).n)
}

export const agentMessagesDb = {
  insert: insertMessage,
  listQueuedForProfile,
  markDelivered: markMessageDelivered,
  markFailed: markMessageFailed,
  countQueued,
}
