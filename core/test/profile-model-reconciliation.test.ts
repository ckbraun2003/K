/**
 * Profile model ↔ runtime Claude default reconciliation (B1).
 *
 * profiles.ts historically froze an env literal ('claude-sonnet-4-6') into every
 * row and startAgentRun always passed it explicitly — so the operator's runtime
 * "Claude default model" setting (config-store claudeDefaultModel, P5.5) never
 * applied to org runs. Now:
 *   - createProfile persists NO override by default (DB sentinel '' ↔ app null),
 *   - startAgentRun resolves a null defaultModel to claudeDefaultModel() AT
 *     DISPATCH TIME (a Settings change applies to the NEXT org run),
 *   - an explicit per-profile override still wins,
 *   - a one-shot guarded migration resets rows still pinning the frozen literal
 *     (an operator override that DIFFERS — or is re-pinned later — survives).
 *
 * supervisor.startRun is mocked (agent-runs.test.ts pattern); the model actually
 * dispatched is read back from vi.mocked(startRun).mock.calls.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, migrate } from '../src/db.js'
import { startRun } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import {
  claudeDefaultModel,
  setClaudeDefaultModel,
  __resetConfigCache,
} from '../src/config-store.js'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real runs
// row: agent_runs.run_id has a FOREIGN KEY → runs(id).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-pmr-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'pmr', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { startAgentRun } = await import('../src/agent-runs.js')

const NULL_MODEL_PROFILE = 'b1-pmr-null'
const OVERRIDE_PROFILE = 'b1-pmr-override'
const MIG_SONNET = 'b1-pmr-mig-sonnet'
const MIG_OPUS = 'b1-pmr-mig-opus'
const FLAG = 'migration.agentProfileModelReset.v1'

/** The model of the LAST startRun dispatch. */
function lastDispatchedModel(): unknown {
  const calls = vi.mocked(startRun).mock.calls
  return (calls[calls.length - 1][1] as Record<string, unknown>).model
}

beforeAll(() => {
  createProfile({ id: NULL_MODEL_PROFILE, name: NULL_MODEL_PROFILE, tier: 'orchestrator' })
  createProfile({
    id: OVERRIDE_PROFILE,
    name: OVERRIDE_PROFILE,
    tier: 'orchestrator',
    defaultModel: 'claude-opus-4-8',
  })
})

beforeEach(() => {
  // Deterministic runtime default: no persisted claude.model, no env override →
  // claudeDefaultModel() === 'claude-sonnet-4-6' (see claude-default-model.test.ts).
  db.prepare(`DELETE FROM app_config WHERE key = 'claude.model'`).run()
  __resetConfigCache()
  delete process.env.CLAUDE_MODEL
})

afterAll(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id LIKE 'b1-pmr-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-pmr-run-%'`).run()
  db.prepare(`DELETE FROM agent_profiles WHERE id LIKE 'b1-pmr-%'`).run()
  // Leave no claude.model override behind (the migration test runs against an
  // ISOLATED temp DB — the shared DB's one-shot flag is never touched here).
  db.prepare(`DELETE FROM app_config WHERE key = 'claude.model'`).run()
  __resetConfigCache()
})

describe('createProfile — null model semantics', () => {
  it('persists NO override by default: app boundary null, DB sentinel \'\'', () => {
    expect(getProfile(NULL_MODEL_PROFILE)!.defaultModel).toBeNull()
    const raw = db
      .prepare(`SELECT default_model FROM agent_profiles WHERE id = ?`)
      .get(NULL_MODEL_PROFILE) as { default_model: string }
    expect(raw.default_model).toBe('')
  })
})

describe('startAgentRun — model resolution at dispatch time', () => {
  it('a null-model profile dispatches at the runtime Claude default — and follows a Settings change', async () => {
    await startAgentRun(NULL_MODEL_PROFILE, { trigger: 'event', goal: 'pmr default' })
    expect(lastDispatchedModel()).toBe(claudeDefaultModel())
    expect(lastDispatchedModel()).toBe('claude-sonnet-4-6') // the clean-state default

    // The operator flips the runtime default — the NEXT org run picks it up.
    setClaudeDefaultModel('claude-fable-5')
    await startAgentRun(NULL_MODEL_PROFILE, { trigger: 'event', goal: 'pmr after-settings' })
    expect(lastDispatchedModel()).toBe('claude-fable-5')
  })

  it('an explicit per-profile override wins regardless of the runtime setting', async () => {
    setClaudeDefaultModel('claude-fable-5')
    await startAgentRun(OVERRIDE_PROFILE, { trigger: 'event', goal: 'pmr override' })
    expect(lastDispatchedModel()).toBe('claude-opus-4-8')
  })
})

describe('migrate — one-shot frozen-literal reset (isolated old-schema DB)', () => {
  // db-migration.test.ts idiom: exercise migrate() against an ISOLATED temp DB, so
  // this test never mutates the shared vitest DB or its real one-shot flag row
  // (whose lifecycle other suites' app_config hygiene must not be coupled to).
  const tmpPath = path.join(os.tmpdir(), `k-b1-model-reset-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('resets only the frozen literal, once; a re-pinned value survives later boots', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // Minimal pre-migration schema: the tables migrate()'s unguarded statements
    // need (projects/runs — see db-migration.test.ts) plus the two this migration
    // reads (agent_profiles carrying the historical frozen literal + app_config).
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL
      );
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL, charter TEXT NOT NULL,
        default_model TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    const now = Date.now()
    const ins = tempDb.prepare(
      `INSERT INTO agent_profiles (id, name, tier, charter, default_model, created_at) VALUES (?, ?, 'orchestrator', 'orchestrator', ?, ?)`,
    )
    ins.run(MIG_SONNET, MIG_SONNET, 'claude-sonnet-4-6', now)
    ins.run(MIG_OPUS, MIG_OPUS, 'claude-opus-4-8', now)

    migrate(tempDb)

    const model = (id: string) =>
      (tempDb.prepare(`SELECT default_model FROM agent_profiles WHERE id = ?`).get(id) as { default_model: string })
        .default_model
    // The frozen literal became the '' sentinel ("no override" — rowToAgentProfile
    // surfaces it as null); a differing override survived.
    expect(model(MIG_SONNET)).toBe('')
    expect(model(MIG_OPUS)).toBe('claude-opus-4-8')
    // The flag is now set.
    expect(tempDb.prepare(`SELECT value FROM app_config WHERE key = ?`).get(FLAG)).toBeTruthy()

    // An operator explicitly RE-PINNING the same literal later must survive the
    // next boot's migrate() — the one-shot flag prevents the re-wipe. Force the
    // FULL scan (the user_version fast path would skip it): the FLAG is under test.
    tempDb.prepare(`UPDATE agent_profiles SET default_model = 'claude-sonnet-4-6' WHERE id = ?`).run(MIG_SONNET)
    tempDb.pragma('user_version = 0')
    migrate(tempDb)
    expect(model(MIG_SONNET)).toBe('claude-sonnet-4-6')
  })
})
