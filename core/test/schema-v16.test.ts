// core/test/schema-v16.test.ts — Continuous Agents W0 (D-122..D-127) v15→v16
// migration + the SCHEMA_SENTINEL newest-column contract. A poison missing ONLY the
// newest version's columns must not evade the sentinel — which is why the fixture is
// v15-COMPLETE (extend it with THIS generation's columns at the next bump; that
// maintenance step IS the newest-column enforcement — see SCHEMA_SENTINEL in db.ts).
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import {
  db, migrate, SCHEMA_VERSION, SCHEMA_SENTINEL,
  domainsDb, agentSessionsDb, agentMessagesDb, kThreadsDb,
} from '../src/db.js'

function cols(d: Database.Database, t: string): string[] {
  return (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
}
function hasTable(d: Database.Database, t: string): boolean {
  return !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
}

/** Exactly the seeded ids the v16 domain stamps target (profiles.ts SEED_PROFILES /
 *  pipeline-seeds.ts PIPELINE_SEEDS) — cross-checked against those modules. */
const LEAD_PROFILE_IDS = ['lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']
const SEED_PIPELINE_DEF_IDS = [
  'code-wave', 'investigate', 'refactor', 'implementation-cycle',
  'deep-research', 'bug-triage', 'security-audit', 'quick-task',
]

/** A v15-COMPLETE scratch DB: every pre-v16 table/column the v16 block touches,
 *  INCLUDING the full v15 column set (pipeline_stages.iteration, pipeline_edges.max_iterations,
 *  pipeline_runs.owner_profile_id, skills.pipeline_def_id) so a sentinel still pointing at a
 *  v15 column would be evaded by this shape. Includes k_threads/agent_profiles/agent_runs
 *  (the tables the v16 ALTERs/backfills/stamps touch) and a real-v15 app_config with every
 *  one-shot mig_* flag already committed — exactly what a production v15 DB carries — so the
 *  pre-v16 one-shots (esp. the seed-profile authority resync, which would otherwise read
 *  agent-config assets from disk) stay no-ops. The three v16 carrier tables (domains /
 *  agent_sessions / agent_messages) ARE present but EMPTY: on a real upgrade boot the new
 *  binary's unconditional db.exec DDL creates them BEFORE migrate() runs (the same
 *  carrier-present shape the v15 test modeled with `skills`). Extend this fixture with the
 *  previous generation's columns at EVERY future SCHEMA_VERSION bump. */
function v15CompleteDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL,
      github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
      bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', health_score INTEGER,
      last_verified_at INTEGER, created_at INTEGER NOT NULL, default_branch TEXT,
      verify_recipe TEXT, auto_merge INTEGER, budget_daily_usd REAL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, worktree TEXT, status TEXT,
      provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      created_at INTEGER, ended_at INTEGER, project_id TEXT REFERENCES projects(id),
      cli_session_id TEXT, reviewed_at INTEGER,
      retry_of TEXT, retry_count INTEGER NOT NULL DEFAULT 0, failure_class TEXT,
      pipeline_stage_id TEXT);
    CREATE TABLE work_items (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, body TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, scope TEXT, project_id TEXT,
      source TEXT, source_key TEXT);
    CREATE TABLE artifacts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, phase TEXT, status TEXT,
      tags TEXT NOT NULL DEFAULT '[]', linked_run_id TEXT, updated_at INTEGER NOT NULL,
      md TEXT NOT NULL, html_path TEXT, project_id TEXT,
      origin TEXT NOT NULL DEFAULT 'compiled' CHECK(origin IN ('compiled','scanned')));
    CREATE TABLE eval_results (id TEXT PRIMARY KEY, evalRunId TEXT NOT NULL, systemId TEXT NOT NULL,
      caseId TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, detPass INTEGER,
      detScore REAL, formatScore REAL, judgeOverall REAL, judgeVerdict TEXT, refusalCorrect INTEGER,
      costUsd REAL, ms INTEGER, numTurns INTEGER, error TEXT, raw TEXT, createdAt INTEGER NOT NULL,
      failure_reason TEXT);
    CREATE TABLE workflow_definitions (id TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL,
      prompt_scaffold TEXT NOT NULL, cross_project INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      spec TEXT);
    CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, definition_id TEXT,
      project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, cwd TEXT NOT NULL,
      base_commit TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
      owner_profile_id TEXT);
    CREATE TABLE pipeline_stages (id TEXT PRIMARY KEY, pipeline_run_id TEXT NOT NULL,
      stage_key TEXT NOT NULL, kind TEXT NOT NULL, profile_id TEXT, spec TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', run_id TEXT, base_commit TEXT, result_commit TEXT,
      exit_code INTEGER, failure_class TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      repair_stage_key TEXT, repairs_used INTEGER NOT NULL DEFAULT 0, gate_resolved_by TEXT,
      gate_note TEXT, cost_usd REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, completed_at INTEGER, iteration INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE pipeline_edges (id TEXT PRIMARY KEY, pipeline_run_id TEXT NOT NULL,
      from_stage_key TEXT, to_stage_key TEXT NOT NULL, handoff TEXT NOT NULL,
      when_cond TEXT NOT NULL DEFAULT 'always'
        CHECK(when_cond IN ('always','pass','fail','repair','loop')),
      max_iterations INTEGER);
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      type TEXT NOT NULL CHECK(type IN ('skill','hook','workflow')), source TEXT NOT NULL,
      triggerType TEXT NOT NULL CHECK(triggerType IN ('manual','schedule','event')),
      schedule TEXT, eventTrigger TEXT, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'k', origin_path TEXT, project_id TEXT, plugin_id TEXT,
      plugin_version TEXT, content_hash TEXT, est_tokens INTEGER, est_tokens_meta INTEGER,
      status TEXT NOT NULL DEFAULT 'ok', last_scanned_at INTEGER, qualified_key TEXT NOT NULL UNIQUE,
      pipeline_def_id TEXT);
    CREATE TABLE k_threads (id TEXT PRIMARY KEY, title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
      active_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      cli_session_id TEXT, archived_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE k_thread_turns (id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES k_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','k')), text TEXT NOT NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);
    CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL CHECK(tier IN ('secretary','chief','orchestrator')),
      charter TEXT NOT NULL CHECK(charter IN ('secretary','chief','orchestrator')),
      default_model TEXT NOT NULL,
      allowed_tools TEXT NOT NULL DEFAULT '[]', mcp_servers TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]', plan_gate INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('user-message','schedule','event','delegation')),
      goal TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, workflow_id TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Every one-shot flag a production v15 DB has already committed. Crucially
    -- mig_seed_profile_authority_resync: WITHOUT it, migrate() would resync this
    -- fixture's seed-id profile rows from the on-disk agent-config assets.
    INSERT INTO app_config (key, value) VALUES
      ('mig_project_tasks_drop', '1'),
      ('mig_work_items_run_scope', '1'),
      ('mig_agent_memory_profile_backfill', '1'),
      ('mig_seed_profile_authority_resync', '1'),
      ('migration.agentProfileModelReset.v1', 'true');
    -- The three v16 CARRIER tables — present (the real app's unconditional db.exec
    -- DDL creates them before migrate() runs on the upgrade boot) but EMPTY. Their
    -- presence with pipeline_runs.domain_id ABSENT is exactly the real-world poison
    -- shape the sentinel test below exercises.
    CREATE TABLE domains (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
      manager_profile_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      cli_session_id TEXT, home_dir TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'stale' CHECK (state IN ('live','resumable','stale')),
      context_tokens INTEGER, last_activity_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (profile_id, thread_id));
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      to_profile_id TEXT NOT NULL, to_thread_id TEXT,
      from_kind TEXT NOT NULL CHECK (from_kind IN ('user','profile')),
      from_profile_id TEXT, body TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed')),
      provenance_run_id TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
  `)
  return d
}

/** Seed the fixture with the pre-upgrade rows the v16 backfills/stamps operate on. */
function insertV15Rows(d: Database.Database): void {
  d.exec(`
    INSERT INTO agent_profiles (id, name, tier, charter, default_model, created_at) VALUES
      ('k-secretary', 'K', 'secretary', 'secretary', '', 1),
      ('chief', 'Chief', 'chief', 'chief', '', 1),
      ('lead-frontend', 'Frontend', 'orchestrator', 'orchestrator', '', 1),
      ('lead-backend', 'Backend', 'orchestrator', 'orchestrator', '', 1),
      ('lead-systems', 'Systems', 'orchestrator', 'orchestrator', '', 1),
      ('lead-security', 'Security', 'orchestrator', 'orchestrator', '', 1),
      ('lead-network', 'Network', 'orchestrator', 'orchestrator', '', 1),
      ('op-custom-uuid', 'Custom Lead', 'orchestrator', 'orchestrator', '', 1);
    INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES
      ('r-chat', 'hi K', '/x', 'done', 1),
      ('r-stage', 'stage work', '/x', 'done', 1),
      ('r-job', 'plain job', '/x', 'done', 1),
      ('r-lead', 'lead delegation', '/x', 'done', 1);
    UPDATE runs SET pipeline_stage_id = 'ps-1' WHERE id = 'r-stage';
    INSERT INTO agent_runs (id, profile_id, run_id, trigger, status, created_at) VALUES
      ('ar-chat', 'k-secretary', 'r-chat', 'user-message', 'completed', 1),
      ('ar-lead', 'lead-backend', 'r-lead', 'delegation', 'completed', 1),
      ('ar-null', 'k-secretary', NULL, 'user-message', 'completed', 1);
    INSERT INTO k_threads (id, title, status, created_at, updated_at) VALUES
      ('th-pre', 'pre-upgrade thread', 'idle', 1, 1);
    INSERT INTO workflow_definitions (id, name, roles, prompt_scaffold, created_at) VALUES
      ('code-wave', 'Code wave', '[]', 'x', 1),
      ('investigate', 'Investigate', '[]', 'x', 1),
      ('refactor', 'Refactor', '[]', 'x', 1),
      ('implementation-cycle', 'Implementation Cycle', '[]', 'x', 1),
      ('deep-research', 'Deep Research', '[]', 'x', 1),
      ('bug-triage', 'Bug Triage & Fix', '[]', 'x', 1),
      ('security-audit', 'Security Audit', '[]', 'x', 1),
      ('quick-task', 'Quick Task', '[]', 'x', 1),
      ('custom-def', 'Operator custom', '[]', 'x', 1);
  `)
}

describe('schema v16', () => {
  it('is version 16 and the sentinel is a v16 migrateSlow-added column', () => {
    expect(SCHEMA_VERSION).toBe(16)
    // The sentinel MUST be a column migrateSlow() ADDs (guarded ALTER on an existing
    // table), never a column on an unconditional-DDL table — see the SCHEMA_SENTINEL
    // note in db.ts. pipeline_runs.domain_id is the last v16 ALTER.
    expect(SCHEMA_SENTINEL).toEqual({ table: 'pipeline_runs', column: 'domain_id' })
  })

  it('creates the three v16 tables, the eight v16 columns, and the engineering domain on the live test DB', () => {
    const live = db as unknown as Database.Database
    expect(live.pragma('user_version', { simple: true })).toBe(16)
    for (const t of ['domains', 'agent_sessions', 'agent_messages']) {
      expect(hasTable(live, t)).toBe(true)
    }
    expect(cols(live, 'domains')).toEqual(expect.arrayContaining(
      ['id', 'name', 'description', 'manager_profile_id', 'created_at'],
    ))
    expect(cols(live, 'agent_sessions')).toEqual(expect.arrayContaining(
      ['id', 'profile_id', 'thread_id', 'cli_session_id', 'home_dir', 'state',
        'context_tokens', 'last_activity_at', 'created_at', 'updated_at'],
    ))
    expect(cols(live, 'agent_messages')).toEqual(expect.arrayContaining(
      ['id', 'to_profile_id', 'to_thread_id', 'from_kind', 'from_profile_id', 'body',
        'priority', 'status', 'provenance_run_id', 'created_at', 'delivered_at'],
    ))
    expect(cols(live, 'k_threads')).toEqual(expect.arrayContaining(['profile_id', 'last_read_at']))
    expect(cols(live, 'runs')).toEqual(expect.arrayContaining(['session_id', 'kind']))
    expect(cols(live, 'agent_profiles')).toEqual(expect.arrayContaining(['domain_id', 'identity_overlay']))
    expect(cols(live, 'workflow_definitions')).toContain('domain_id')
    expect(cols(live, 'pipeline_runs')).toContain('domain_id')
    // The engineering domain seed applies on the live DB (its carrier table comes
    // from the unconditional DDL, so the migrateSlow seed always sees it).
    const eng = live.prepare(`SELECT * FROM domains WHERE id = 'engineering'`).get() as Record<string, unknown>
    expect(eng).toBeDefined()
    expect(eng.name).toBe('Engineering')
    expect(eng.manager_profile_id).toBe('chief')
  })

  it('v15→v16 upgrade: preserves rows, backfills runs.kind, defaults k_threads.profile_id, seeds + stamps engineering', () => {
    const d = v15CompleteDb()
    insertV15Rows(d)
    d.pragma('user_version = 15') // an honestly-stamped v15 DB
    migrate(d)
    expect(d.pragma('user_version', { simple: true })).toBe(16)

    // columns landed
    expect(cols(d, 'k_threads')).toEqual(expect.arrayContaining(['profile_id', 'last_read_at']))
    expect(cols(d, 'runs')).toEqual(expect.arrayContaining(['session_id', 'kind']))
    expect(cols(d, 'agent_profiles')).toEqual(expect.arrayContaining(['domain_id', 'identity_overlay']))
    expect(cols(d, 'workflow_definitions')).toContain('domain_id')
    expect(cols(d, 'pipeline_runs')).toContain('domain_id')

    // rows preserved
    expect((d.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(4)
    expect((d.prepare(`SELECT COUNT(*) AS n FROM agent_profiles`).get() as { n: number }).n).toBe(8)
    expect((d.prepare(`SELECT COUNT(*) AS n FROM workflow_definitions`).get() as { n: number }).n).toBe(9)
    expect((d.prepare(`SELECT prompt FROM runs WHERE id = 'r-chat'`).get() as { prompt: string }).prompt).toBe('hi K')

    // runs.kind backfill: K chat turns → 'chat-turn'; pipeline-stage runs →
    // 'pipeline-stage'; everything else keeps the 'job' default (including a
    // lead delegation and a k-secretary agent_runs row with run_id NULL).
    const kindOf = (id: string) => (d.prepare(`SELECT kind FROM runs WHERE id = ?`).get(id) as { kind: string }).kind
    expect(kindOf('r-chat')).toBe('chat-turn')
    expect(kindOf('r-stage')).toBe('pipeline-stage')
    expect(kindOf('r-job')).toBe('job')
    expect(kindOf('r-lead')).toBe('job')

    // pre-existing K threads take the NOT NULL DEFAULT 'k-secretary'
    const th = d.prepare(`SELECT profile_id, last_read_at FROM k_threads WHERE id = 'th-pre'`).get() as Record<string, unknown>
    expect(th.profile_id).toBe('k-secretary')
    expect(th.last_read_at).toBeNull()

    // engineering domain seeded exactly once, managed by chief
    const domains = d.prepare(`SELECT * FROM domains`).all() as Array<Record<string, unknown>>
    expect(domains.length).toBe(1)
    expect(domains[0].id).toBe('engineering')
    expect(domains[0].name).toBe('Engineering')
    expect(domains[0].manager_profile_id).toBe('chief')

    // the five seeded lead-* profiles are stamped; other profiles are NOT
    const domainOfProfile = (id: string) =>
      (d.prepare(`SELECT domain_id FROM agent_profiles WHERE id = ?`).get(id) as { domain_id: string | null }).domain_id
    for (const id of LEAD_PROFILE_IDS) expect(domainOfProfile(id)).toBe('engineering')
    expect(domainOfProfile('k-secretary')).toBeNull()
    expect(domainOfProfile('chief')).toBeNull()
    expect(domainOfProfile('op-custom-uuid')).toBeNull()

    // the eight seeded standard pipeline defs are stamped; an operator def is NOT
    const domainOfDef = (id: string) =>
      (d.prepare(`SELECT domain_id FROM workflow_definitions WHERE id = ?`).get(id) as { domain_id: string | null }).domain_id
    for (const id of SEED_PIPELINE_DEF_IDS) expect(domainOfDef(id)).toBe('engineering')
    expect(domainOfDef('custom-def')).toBeNull()
    d.close()
  })

  it('seeds + backfills are idempotent: a second migrate() AND a forced full re-scan are no-ops', () => {
    const d = v15CompleteDb()
    insertV15Rows(d)
    d.pragma('user_version = 15')
    migrate(d)
    const engBefore = d.prepare(`SELECT * FROM domains WHERE id = 'engineering'`).get() as Record<string, unknown>
    // Operator edits after the upgrade: these MUST survive any later re-scan.
    d.exec(`UPDATE runs SET kind = 'job' WHERE id = 'r-stage'`) // operator re-classified
    d.exec(`UPDATE workflow_definitions SET domain_id = NULL WHERE id = 'quick-task'`)

    migrate(d) // fast path (version + sentinel both good) — trivially a no-op
    // …then force the FULL scan (the poisoned-stamp heal path re-runs every step):
    d.pragma('user_version = 0')
    migrate(d)

    expect(d.pragma('user_version', { simple: true })).toBe(16)
    // still exactly one engineering domain, byte-identical (INSERT OR IGNORE)
    const domains = d.prepare(`SELECT * FROM domains`).all() as Array<Record<string, unknown>>
    expect(domains.length).toBe(1)
    expect(domains[0]).toEqual(engBefore)
    // the one-shot flag keeps the kind backfill from re-stamping the operator's edit
    expect((d.prepare(`SELECT kind FROM runs WHERE id = 'r-stage'`).get() as { kind: string }).kind).toBe('job')
    // NB the domain stamps are deliberately NOT one-shot — `WHERE domain_id IS NULL`
    // re-covers a seeded row an operator cleared, which is the documented semantic:
    expect((d.prepare(`SELECT domain_id FROM workflow_definitions WHERE id = 'quick-task'`).get() as { domain_id: string | null }).domain_id).toBe('engineering')
    // untouched rows unchanged
    expect((d.prepare(`SELECT domain_id FROM workflow_definitions WHERE id = 'custom-def'`).get() as { domain_id: string | null }).domain_id).toBeNull()
    expect((d.prepare(`SELECT kind FROM runs WHERE id = 'r-chat'`).get() as { kind: string }).kind).toBe('chat-turn')
    d.close()
  })

  it('NEWEST-COLUMN sentinel: a v15-complete DB stamped 16 (missing only v16 additions) self-heals', () => {
    const d = v15CompleteDb()
    // Guard the guard: this fixture MUST already hold the OLD (v15) sentinel column — if
    // SCHEMA_SENTINEL still named skills.pipeline_def_id, this poison would evade it.
    expect(cols(d, 'skills')).toContain('pipeline_def_id')
    // The sentinel's carrier table (pipeline_runs) IS present in the poison — exactly as
    // the real app's unconditional db.exec DDL guarantees before migrate() runs — but its
    // v16 column is absent.
    expect(hasTable(d, SCHEMA_SENTINEL.table)).toBe(true)
    expect(cols(d, SCHEMA_SENTINEL.table)).not.toContain(SCHEMA_SENTINEL.column)
    expect(cols(d, 'k_threads')).not.toContain('profile_id')
    expect(cols(d, 'runs')).not.toContain('kind')
    expect(cols(d, 'agent_profiles')).not.toContain('domain_id')
    expect(cols(d, 'workflow_definitions')).not.toContain('domain_id')
    d.pragma(`user_version = ${SCHEMA_VERSION}`) // the poison
    migrate(d)
    expect(cols(d, 'k_threads')).toEqual(expect.arrayContaining(['profile_id', 'last_read_at']))
    expect(cols(d, 'runs')).toEqual(expect.arrayContaining(['session_id', 'kind']))
    expect(cols(d, 'agent_profiles')).toEqual(expect.arrayContaining(['domain_id', 'identity_overlay']))
    expect(cols(d, 'workflow_definitions')).toContain('domain_id')
    expect(cols(d, 'pipeline_runs')).toContain('domain_id')
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })

  it('agent_sessions enforces UNIQUE(profile_id, thread_id)', () => {
    const live = db as unknown as Database.Database
    const p = `p-${randomUUID()}`
    const t = `t-${randomUUID()}`
    const ins = live.prepare(`
      INSERT INTO agent_sessions (id, profile_id, thread_id, home_dir, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'stale', 1, 1)
    `)
    ins.run(`s-${randomUUID()}`, p, t, 'C:/tmp/home')
    expect(() => ins.run(`s-${randomUUID()}`, p, t, 'C:/tmp/home')).toThrow(/UNIQUE/)
  })

  it('domainsDb round-trip: create / get / list / update', () => {
    const id = `dom-${randomUUID()}`
    const now = Date.now()
    domainsDb.create.run({ id, name: `Ops ${id}`, description: null, managerProfileId: null, createdAt: now })
    const row = domainsDb.get.get(id) as Record<string, unknown>
    expect(row.name).toBe(`Ops ${id}`)
    expect(row.description).toBeNull()
    expect(row.manager_profile_id).toBeNull()
    expect(row.created_at).toBe(now)
    domainsDb.update.run({ id, name: `Ops2 ${id}`, description: 'operations', managerProfileId: 'chief' })
    const updated = domainsDb.get.get(id) as Record<string, unknown>
    expect(updated.name).toBe(`Ops2 ${id}`)
    expect(updated.description).toBe('operations')
    expect(updated.manager_profile_id).toBe('chief')
    const all = domainsDb.list.all() as Array<Record<string, unknown>>
    expect(all.map(r => r.id)).toEqual(expect.arrayContaining(['engineering', id]))
  })

  it('agentSessionsDb round-trip: upsert insert/refresh, get, setState, setCliSessionId, touch, listByState', () => {
    const p = `p-${randomUUID()}`
    const t = `t-${randomUUID()}`
    const now = Date.now()
    const first = agentSessionsDb.upsert({
      id: `as-${randomUUID()}`, profileId: p, threadId: t, cliSessionId: null,
      homeDir: 'C:/tmp/home', state: 'live', contextTokens: null, lastActivityAt: null,
      createdAt: now, updatedAt: now,
    })
    expect(first.profile_id).toBe(p)
    expect(first.state).toBe('live')
    expect(first.cli_session_id).toBeNull()
    // conflict path: SAME (profile, thread) — the existing row's id/created_at are
    // kept, the mutable fields refresh.
    const second = agentSessionsDb.upsert({
      id: `as-${randomUUID()}`, profileId: p, threadId: t, cliSessionId: 'cli-1',
      homeDir: 'C:/tmp/home2', state: 'resumable', contextTokens: 1234, lastActivityAt: now + 1,
      createdAt: now + 1, updatedAt: now + 1,
    })
    expect(second.id).toBe(first.id)
    expect(second.created_at).toBe(now)
    expect(second.cli_session_id).toBe('cli-1')
    expect(second.home_dir).toBe('C:/tmp/home2')
    expect(second.state).toBe('resumable')
    expect(second.context_tokens).toBe(1234)

    const byId = agentSessionsDb.get.get(first.id) as Record<string, unknown>
    expect(byId.thread_id).toBe(t)
    const byPair = agentSessionsDb.getByProfileThread.get(p, t) as Record<string, unknown>
    expect(byPair.id).toBe(first.id)

    agentSessionsDb.setState.run('stale', now + 2, first.id as string)
    const stale = agentSessionsDb.listByState.all('stale') as Array<Record<string, unknown>>
    expect(stale.map(r => r.id)).toContain(first.id)

    agentSessionsDb.setCliSessionId.run('cli-2', now + 3, first.id as string)
    agentSessionsDb.touch(first.id as string, now + 4)
    const after = agentSessionsDb.get.get(first.id) as Record<string, unknown>
    expect(after.cli_session_id).toBe('cli-2')
    expect(after.last_activity_at).toBe(now + 4)
    expect(after.updated_at).toBe(now + 4)
  })

  it('agentMessagesDb round-trip: insert queued, list in created_at order, deliver/fail, countQueued', () => {
    const p = `p-${randomUUID()}`
    const m1 = `m-${randomUUID()}`
    const m2 = `m-${randomUUID()}`
    agentMessagesDb.insert.run({
      id: m1, toProfileId: p, toThreadId: null, fromKind: 'user', fromProfileId: null,
      body: 'hello there', priority: 'normal', provenanceRunId: null, createdAt: 100,
    })
    agentMessagesDb.insert.run({
      id: m2, toProfileId: p, toThreadId: `t-${randomUUID()}`, fromKind: 'profile', fromProfileId: 'chief',
      body: 'urgent steer', priority: 'urgent', provenanceRunId: 'r-x', createdAt: 50,
    })
    expect(agentMessagesDb.countQueued(p)).toBe(2)
    const queued = agentMessagesDb.listQueuedForProfile.all(p) as Array<Record<string, unknown>>
    // created_at ASC — urgent-first is Lane B's delivery policy, NOT a store concern
    expect(queued.map(r => r.id)).toEqual([m2, m1])
    expect(queued[1].status).toBe('queued')
    expect(queued[1].delivered_at).toBeNull()

    agentMessagesDb.markDelivered.run(777, m1)
    const delivered = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(m1) as Record<string, unknown>
    expect(delivered.status).toBe('delivered')
    expect(delivered.delivered_at).toBe(777)
    expect(agentMessagesDb.countQueued(p)).toBe(1)

    agentMessagesDb.markFailed.run(m2)
    const failed = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(m2) as Record<string, unknown>
    expect(failed.status).toBe('failed')
    expect(failed.delivered_at).toBeNull() // delivered_at is stamped on DELIVERY only
    expect(agentMessagesDb.countQueued(p)).toBe(0)
  })

  it('kThreadsDb gains listByProfile + setLastReadAt without disturbing existing members', () => {
    const id = `th-${randomUUID()}`
    const now = Date.now()
    kThreadsDb.insertThread.run({ id, title: 'v16 smoke', status: 'idle', activeRunId: null, createdAt: now, updatedAt: now })
    // insertThread predates v16 and binds no profile_id → the column DEFAULT applies
    const mine = kThreadsDb.listByProfile.all('k-secretary') as Array<Record<string, unknown>>
    expect(mine.map(r => r.id)).toContain(id)
    const other = kThreadsDb.listByProfile.all(`p-${randomUUID()}`) as Array<Record<string, unknown>>
    expect(other.map(r => r.id)).not.toContain(id)

    kThreadsDb.setLastReadAt.run(now + 5, id)
    const row = kThreadsDb.getThread.get(id) as Record<string, unknown>
    expect(row.last_read_at).toBe(now + 5)
    // marking read must NOT bump updated_at (it would spuriously reorder the list)
    expect(row.updated_at).toBe(now)
  })
})
