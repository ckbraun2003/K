/**
 * agent-mail.ts — queueMessage + pure resolveDelivery + tier-gate mayMessage
 * (Continuous Agents B.1, D-124). DB-backed, SDK-free; fixtures are guard-created
 * with ca-b-* ids and removed in afterAll (shared-DB discipline).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../src/db.js'
import { createProfile, getProfile } from '../src/profiles.js'
import {
  queueMessage,
  resolveDelivery,
  mayMessage,
  rowToAgentMessage,
  AgentMailError,
} from '../src/agent-mail.js'

type Row = Record<string, unknown>

// ── fixtures ──────────────────────────────────────────────────────────────────
const createdProfiles: string[] = []
function ensureProfile(id: string, name: string, tier: 'secretary' | 'chief' | 'orchestrator') {
  if (!getProfile(id)) {
    createProfile({ id, name, tier })
    createdProfiles.push(id)
  }
}

const T = {
  mgr: 'ca-b-mgr',            // chief-tier manager of ca-b-domain
  otherMgr: 'ca-b-mgr2',      // chief-tier manager of NO domain
  lead: 'ca-b-lead',          // orchestrator in ca-b-domain
  stray: 'ca-b-stray',        // orchestrator with NO domain
  worker: 'ca-b-worker-none', // never created — the workers-have-no-profile case
}

beforeAll(() => {
  ensureProfile('k-secretary', 'K', 'secretary')
  ensureProfile(T.mgr, 'CaBMgr', 'chief')
  ensureProfile(T.otherMgr, 'CaBMgr2', 'chief')
  ensureProfile(T.lead, 'CaBLead', 'orchestrator')
  ensureProfile(T.stray, 'CaBStray', 'orchestrator')
  // Domain row + membership (raw SQL — Lane C owns the domains API).
  db.prepare(
    `INSERT OR IGNORE INTO domains (id, name, description, manager_profile_id, created_at) VALUES (?, ?, NULL, ?, ?)`,
  ).run('ca-b-domain', 'CaB Domain', T.mgr, Date.now())
  db.prepare(`UPDATE agent_profiles SET domain_id = 'ca-b-domain' WHERE id = ?`).run(T.lead)
})

beforeEach(() => {
  db.prepare(`DELETE FROM agent_messages WHERE to_profile_id LIKE 'ca-b-%'`).run()
  db.prepare(`DELETE FROM k_threads WHERE id LIKE 'ca-b-%' OR id LIKE 'kt-ca-b-%'`).run()
  db.prepare(`DELETE FROM pipeline_stages WHERE pipeline_run_id LIKE 'ca-b-%'`).run()
  db.prepare(`DELETE FROM pipeline_runs WHERE id LIKE 'ca-b-%'`).run()
})

afterAll(() => {
  db.prepare(`DELETE FROM agent_messages WHERE to_profile_id LIKE 'ca-b-%'`).run()
  db.prepare(`DELETE FROM k_threads WHERE id LIKE 'ca-b-%' OR id LIKE 'kt-ca-b-%'`).run()
  db.prepare(`DELETE FROM pipeline_stages WHERE pipeline_run_id LIKE 'ca-b-%'`).run()
  db.prepare(`DELETE FROM pipeline_runs WHERE id LIKE 'ca-b-%'`).run()
  db.prepare(`DELETE FROM domains WHERE id = 'ca-b-domain'`).run()
  for (const id of createdProfiles) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
})

/** Seed a pipeline run owned by `owner` with one stage acted by `actor` in `status`. */
function seedStage(owner: string, actor: string, status: string): string {
  const prId = `ca-b-pr-${randomUUID().slice(0, 8)}`
  db.prepare(
    `INSERT INTO pipeline_runs (id, definition_id, project_id, title, cwd, base_commit, status, created_at, updated_at, completed_at, owner_profile_id)
     VALUES (?, NULL, NULL, 'ca-b', '.', 'deadbeef', 'running', ?, ?, NULL, ?)`,
  ).run(prId, Date.now(), Date.now(), owner)
  db.prepare(
    `INSERT INTO pipeline_stages (id, pipeline_run_id, stage_key, kind, profile_id, spec, status, created_at, updated_at)
     VALUES (?, ?, 's1', 'agent', ?, '{}', ?, ?, ?)`,
  ).run(randomUUID(), prId, actor, status, Date.now(), Date.now())
  return prId
}

/** A thread owned by `profileId` (raw insert — mirrors agent-sessions' local statement). */
function seedThread(id: string, profileId: string): string {
  db.prepare(
    `INSERT INTO k_threads (id, title, status, profile_id, created_at, updated_at) VALUES (?, NULL, 'active', ?, ?, ?)`,
  ).run(id, profileId, Date.now(), Date.now())
  return id
}

// ── resolveDelivery — the full state × priority matrix ───────────────────────

describe('resolveDelivery — pure delivery matrix', () => {
  const normal = { priority: 'normal' as const }
  const urgent = { priority: 'urgent' as const }

  it('live + parked (not mid-turn) → stdin-now for both priorities', () => {
    expect(resolveDelivery({ state: 'live', midTurn: false }, normal)).toBe('stdin-now')
    expect(resolveDelivery({ state: 'live', midTurn: false }, urgent)).toBe('stdin-now')
  })

  it('live + mid-turn → boundary (normal) / interrupt (urgent)', () => {
    expect(resolveDelivery({ state: 'live', midTurn: true }, normal)).toBe('boundary')
    expect(resolveDelivery({ state: 'live', midTurn: true }, urgent)).toBe('interrupt')
  })

  it('idle (resumable/stale) → wake regardless of priority or midTurn flag — all 8 cells', () => {
    for (const state of ['resumable', 'stale'] as const) {
      for (const midTurn of [false, true]) {
        for (const message of [normal, urgent]) {
          expect(resolveDelivery({ state, midTurn }, message), `${state}/${midTurn}/${message.priority}`).toBe('wake')
        }
      }
    }
  })
})

// ── mayMessage — tier-gate matrix ─────────────────────────────────────────────

describe('mayMessage — tier-gate matrix', () => {
  it('user → anyone', () => {
    expect(mayMessage({ kind: 'user' }, 'k-secretary')).toBe(true)
    expect(mayMessage({ kind: 'user' }, T.lead)).toBe(true)
  })

  it('K (secretary) → anyone except itself', () => {
    const k = { kind: 'profile' as const, profileId: 'k-secretary' }
    expect(mayMessage(k, T.mgr)).toBe(true)
    expect(mayMessage(k, T.lead)).toBe(true)
    expect(mayMessage(k, 'k-secretary')).toBe(false) // self-send loop guard
  })

  it('self-send is denied for EVERY tier (the guard sits before the tier branches)', () => {
    // A chief inside its own managed domain would otherwise be granted by the
    // domain join; a lead by a stage row. The guard must fire first.
    expect(mayMessage({ kind: 'profile', profileId: T.mgr }, T.mgr)).toBe(false)
    expect(mayMessage({ kind: 'profile', profileId: T.lead }, T.lead)).toBe(false)
  })

  it('unknown sender profile (workers) → nobody', () => {
    expect(mayMessage({ kind: 'profile', profileId: T.worker }, 'k-secretary')).toBe(false)
  })

  it("manager (chief tier) → K + its OWN domain's agents only", () => {
    const mgr = { kind: 'profile' as const, profileId: T.mgr }
    expect(mayMessage(mgr, 'k-secretary')).toBe(true)
    expect(mayMessage(mgr, T.lead)).toBe(true)        // in ca-b-domain
    expect(mayMessage(mgr, T.stray)).toBe(false)      // no domain
    expect(mayMessage(mgr, T.otherMgr)).toBe(false)   // another chief, no shared domain
    // A chief managing NO domain reaches only K.
    const mgr2 = { kind: 'profile' as const, profileId: T.otherMgr }
    expect(mayMessage(mgr2, 'k-secretary')).toBe(true)
    expect(mayMessage(mgr2, T.lead)).toBe(false)
  })

  it('orchestrator → its manager (via its domain) but NOT K nor arbitrary profiles', () => {
    const lead = { kind: 'profile' as const, profileId: T.lead }
    expect(mayMessage(lead, T.mgr)).toBe(true)        // ca-b-domain's manager
    expect(mayMessage(lead, 'k-secretary')).toBe(false)
    expect(mayMessage(lead, T.otherMgr)).toBe(false)
    // No domain → no manager route.
    expect(mayMessage({ kind: 'profile', profileId: T.stray }, T.mgr)).toBe(false)
  })

  it('orchestrator in a domain with a NULL manager → the manager route yields nobody', () => {
    db.prepare(
      `INSERT OR IGNORE INTO domains (id, name, description, manager_profile_id, created_at) VALUES (?, ?, NULL, NULL, ?)`,
    ).run('ca-b-domain-nomgr', 'CaB NoMgr', Date.now())
    db.prepare(`UPDATE agent_profiles SET domain_id = 'ca-b-domain-nomgr' WHERE id = ?`).run(T.stray)
    try {
      expect(mayMessage({ kind: 'profile', profileId: T.stray }, T.mgr)).toBe(false)
      expect(mayMessage({ kind: 'profile', profileId: T.stray }, 'k-secretary')).toBe(false)
    } finally {
      db.prepare(`UPDATE agent_profiles SET domain_id = NULL WHERE id = ?`).run(T.stray)
      db.prepare(`DELETE FROM domains WHERE id = 'ca-b-domain-nomgr'`).run()
    }
  })

  it('orchestrator → a profile RUNNING one of its stages (dispatched/running only)', () => {
    const stray = { kind: 'profile' as const, profileId: T.stray }
    expect(mayMessage(stray, T.lead)).toBe(false)
    seedStage(T.stray, T.lead, 'pending')
    expect(mayMessage(stray, T.lead)).toBe(false)     // pending stage is not yet a partner
    seedStage(T.stray, T.lead, 'running')
    expect(mayMessage(stray, T.lead)).toBe(true)
    db.prepare(`UPDATE pipeline_stages SET status = 'passed' WHERE profile_id = ?`).run(T.lead)
    expect(mayMessage(stray, T.lead)).toBe(false)     // terminal stage no longer reachable
    seedStage(T.stray, T.lead, 'dispatched')
    expect(mayMessage(stray, T.lead)).toBe(true)
    // Someone ELSE's pipeline never grants the pair.
    db.prepare(`DELETE FROM pipeline_stages WHERE pipeline_run_id LIKE 'ca-b-%'`).run()
    db.prepare(`DELETE FROM pipeline_runs WHERE id LIKE 'ca-b-%'`).run()
    seedStage(T.mgr, T.lead, 'running')
    expect(mayMessage(stray, T.lead)).toBe(false)
  })
})

// ── queueMessage ──────────────────────────────────────────────────────────────

describe('queueMessage — validated insert over agentMessagesDb', () => {
  it('queues with defaults (normal, queued, delivered_at NULL) and returns the mapped row', () => {
    const tid = seedThread('ca-b-th1', T.mgr)
    const m = queueMessage({
      toProfileId: T.mgr,
      toThreadId: tid,
      from: { kind: 'profile', profileId: 'k-secretary' },
      body: 'please review the wave',
    })
    expect(m.toProfileId).toBe(T.mgr)
    expect(m.toThreadId).toBe(tid)
    expect(m.fromKind).toBe('profile')
    expect(m.fromProfileId).toBe('k-secretary')
    expect(m.priority).toBe('normal')
    expect(m.status).toBe('queued')
    expect(m.deliveredAt).toBeNull()
    expect(m.provenanceRunId).toBeNull()
    const raw = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(m.id) as Row
    expect(rowToAgentMessage(raw)).toEqual(m)
  })

  it('stamps priority + provenanceRunId + user fromKind when given', () => {
    const tid = seedThread('ca-b-th2', T.mgr)
    const m = queueMessage({
      toProfileId: T.mgr, toThreadId: tid, from: { kind: 'user' },
      body: 'urgent steer', priority: 'urgent', provenanceRunId: 'ca-b-run-1',
    })
    expect(m.fromKind).toBe('user')
    expect(m.fromProfileId).toBeNull()
    expect(m.priority).toBe('urgent')
    expect(m.provenanceRunId).toBe('ca-b-run-1')
  })

  it('rejects empty body, unknown target profile, unknown thread, and a foreign-owned thread', () => {
    expect(() => queueMessage({ toProfileId: T.mgr, from: { kind: 'user' }, body: '' }))
      .toThrow(AgentMailError)
    expect(() => queueMessage({ toProfileId: T.mgr, from: { kind: 'user' }, body: '   \n ' }))
      .toThrow(/non-empty/) // whitespace-only would deliver a blank steering block
    expect(() => queueMessage({ toProfileId: 'ca-b-nobody', from: { kind: 'user' }, body: 'x' }))
      .toThrow(/unknown target profile/)
    expect(() => queueMessage({ toProfileId: T.mgr, toThreadId: 'ca-b-missing', from: { kind: 'user' }, body: 'x' }))
      .toThrow(/unknown thread/)
    const foreign = seedThread('ca-b-th3', T.lead)
    expect(() => queueMessage({ toProfileId: T.mgr, toThreadId: foreign, from: { kind: 'user' }, body: 'x' }))
      .toThrow(/not owned by/)
  })

  it('a NULL toThreadId is stored as NULL (the relay resolves it at delivery time)', () => {
    const m = queueMessage({ toProfileId: T.mgr, from: { kind: 'user' }, body: 'no thread yet' })
    expect(m.toThreadId).toBeNull()
  })
})

// ── the pre-authorized queue index ────────────────────────────────────────────

describe('agent_messages queue index', () => {
  it('idx_agent_messages_queue exists on (to_profile_id, status)', () => {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_messages_queue'`,
    ).get() as { sql?: string } | undefined
    // Pin the COLUMN ORDER, not mere presence — (status, to_profile_id) would not
    // serve the profile-leading equality reads.
    expect(row?.sql).toMatch(/to_profile_id\s*,\s*status/)
  })
})
