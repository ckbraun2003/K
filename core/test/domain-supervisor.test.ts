/**
 * domain-supervisor.ts — always-on, governed domain oversight (C.4, D-125).
 *
 * chief-wake harness posture: no fake timers — inject `now`; call exported
 * bodies directly; clean rows per test. Isolated DB via vitest.config.ts
 * K_DATA_DIR. Briefing discriminator: the SELF-ADDRESSED manager message
 * (to == from == manager, from_kind 'profile').
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db, configDb } from '../src/db.js'
import { seedProfiles } from '../src/profiles.js'
import { stampSeededDomainMemberships } from '../src/domains.js'
import {
  briefDomain, buildBriefing, domainHasActiveWork, heartbeatTick,
  onSupervisorRunUpdate, onSupervisorPipelineTerminal, onSupervisorGateParked,
  resetDomainSupervisorState, startDomainSupervisor,
  DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR,
} from '../src/domain-supervisor.js'

const T = 1_800_000_000_000 // fixed base timestamp
const briefingsFor = (mgr: string) =>
  db.prepare(`SELECT * FROM agent_messages WHERE to_profile_id = ? AND from_profile_id = ? AND from_kind = 'profile' ORDER BY created_at ASC`).all(mgr, mgr) as Array<Record<string, unknown>>
const wipeBriefings = () =>
  db.prepare(`DELETE FROM agent_messages WHERE to_profile_id = from_profile_id AND from_kind = 'profile'`).run()

function insertPipelineRun(domainId: string | null, status = 'running'): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO pipeline_runs (id, definition_id, project_id, title, cwd, base_commit, status, created_at, updated_at, completed_at, owner_profile_id, domain_id)
              VALUES (?, NULL, NULL, 'sup-test', '.', 'base', ?, ?, ?, NULL, NULL, ?)`)
    .run(id, status, T, T, domainId)
  return id
}
function insertStage(pipelineRunId: string, status: string, key = 's1'): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO pipeline_stages (id, pipeline_run_id, stage_key, kind, spec, status, created_at, updated_at)
              VALUES (?, ?, ?, 'gate', '{}', ?, ?, ?)`).run(id, pipelineRunId, key, status, T, T)
  return id
}
const cleanup: string[] = []

beforeEach(() => {
  seedProfiles(); stampSeededDomainMemberships()
  resetDomainSupervisorState()
  wipeBriefings()
  configDb.set('domain_wake_max_per_hour', String(DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR))
})
afterAll(() => {
  wipeBriefings()
  for (const id of cleanup) {
    // pipeline_ledger carries no FK (no cascade) — sweep it alongside its run.
    db.prepare(`DELETE FROM pipeline_ledger WHERE pipeline_run_id = ?`).run(id)
    db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(id)
  }
  db.prepare(`DELETE FROM app_config WHERE key = 'domain_wake_max_per_hour'`).run()
})

describe('governor (C.4)', () => {
  it('event briefing writes ONE self-addressed mailbox row to the manager conversation', () => {
    const out = briefDomain('engineering', { kind: 'run-terminal', detail: 'run r1 → done' }, T)
    expect(out).toMatchObject({ briefed: true })
    const rows = briefingsFor('chief')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ to_profile_id: 'chief', from_profile_id: 'chief',
      from_kind: 'profile', priority: 'normal', status: 'queued' })
    expect(rows[0].to_thread_id).toBe('kt-chief') // paired via getOrCreateConversation
    expect(String(rows[0].body)).toContain('[domain briefing · Engineering · run-terminal]')
  })

  it('min-interval debounce: a burst yields one row; suppressed wakes create NO rows', () => {
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T).briefed).toBe(true)
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T + 1000))
      .toEqual({ briefed: false, reason: 'debounced' })
    expect(briefDomain('engineering', { kind: 'gate', urgent: true }, T + 2000))
      .toEqual({ briefed: false, reason: 'debounced' }) // urgent does NOT bypass (bounded spend)
    expect(briefingsFor('chief')).toHaveLength(1)
  })

  it('rolling-hour cap from app_config domain_wake_max_per_hour (DB-backed, restart-safe)', () => {
    configDb.set('domain_wake_max_per_hour', '2')
    const MIN = 10 * 60_000
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T).briefed).toBe(true)
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T + MIN + 1).briefed).toBe(true)
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T + 2 * (MIN + 1)))
      .toEqual({ briefed: false, reason: 'rate-capped' })
    expect(briefingsFor('chief')).toHaveLength(2)
    // cap 0 = hard off switch
    configDb.set('domain_wake_max_per_hour', '0')
    resetDomainSupervisorState(); wipeBriefings()
    expect(briefDomain('engineering', { kind: 'run-terminal' }, T))
      .toEqual({ briefed: false, reason: 'rate-capped' })
  })

  it('unknown domain / manager-less domain → no row', () => {
    expect(briefDomain('nope-' + randomUUID(), { kind: 'run-terminal' }, T))
      .toEqual({ briefed: false, reason: 'no-domain' })
    const bare = randomUUID().slice(0, 8)
    db.prepare(`INSERT INTO domains (id, name, description, manager_profile_id, created_at) VALUES (?, ?, NULL, NULL, ?)`)
      .run(`p51-${bare}`, `P51 ${bare}`, T)
    expect(briefDomain(`p51-${bare}`, { kind: 'run-terminal' }, T))
      .toEqual({ briefed: false, reason: 'no-manager' })
    db.prepare(`DELETE FROM domains WHERE id = ?`).run(`p51-${bare}`)
    expect(briefingsFor('chief')).toHaveLength(0)
  })
})

describe('heartbeat active-work gate (C.4)', () => {
  it('no active work → no-active-work, NO row; running domain pipeline → briefing', () => {
    expect(briefDomain('engineering', { kind: 'heartbeat' }, T))
      .toEqual({ briefed: false, reason: 'no-active-work' })
    const pr = insertPipelineRun('engineering'); cleanup.push(pr)
    expect(domainHasActiveWork('engineering')).toBe(true)
    expect(briefDomain('engineering', { kind: 'heartbeat' }, T).briefed).toBe(true)
    db.prepare(`UPDATE pipeline_runs SET status = 'completed' WHERE id = ?`).run(pr)
  })

  it('heartbeatTick sweeps every managed domain through the same gate', () => {
    heartbeatTick(T) // engineering idle → nothing
    expect(briefingsFor('chief')).toHaveLength(0)
  })
})

describe('event resolution (C.4)', () => {
  function terminalRunFor(profileId: string, status = 'done') {
    const runId = randomUUID()
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, provider, model, tokens_in, tokens_out, cost_usd, created_at)
                VALUES (?, 'x', '.', ?, 'claude', 'm', 0, 0, 0, ?)`).run(runId, status, T)
    const arId = randomUUID()
    db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
                VALUES (?, ?, ?, 'delegation', 'g', 'completed', ?)`).run(arId, profileId, runId, T)
    cleanupRuns.push(runId, arId)
    return { id: runId, status } as never // minimal Run shape for the handler
  }
  const cleanupRuns: string[] = []
  afterAll(() => {
    for (const id of cleanupRuns) {
      db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(id)
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(id)
    }
  })

  it('domain-member terminal run → briefing; manager self-run + unattributed → skipped', () => {
    onSupervisorRunUpdate(terminalRunFor('lead-frontend'))
    expect(briefingsFor('chief')).toHaveLength(1)
    resetDomainSupervisorState(); wipeBriefings()
    onSupervisorRunUpdate(terminalRunFor('chief'))       // self-guard
    onSupervisorRunUpdate(terminalRunFor('k-secretary')) // no domain
    expect(briefingsFor('chief')).toHaveLength(0)
  })

  it('pipeline terminal resolves via pipeline_runs.domain_id; failure kind lands in the body', () => {
    const pr = insertPipelineRun('engineering', 'failed'); cleanup.push(pr)
    onSupervisorPipelineTerminal(pr, 'failed')
    const rows = briefingsFor('chief')
    expect(rows).toHaveLength(1)
    expect(String(rows[0].body)).toContain('failure')
  })

  it('gate park → URGENT briefing', () => {
    const pr = insertPipelineRun('engineering'); cleanup.push(pr)
    const sid = insertStage(pr, 'awaiting_gate')
    onSupervisorGateParked(pr, sid)
    const rows = briefingsFor('chief')
    expect(rows).toHaveLength(1)
    expect(rows[0].priority).toBe('urgent')
  })
})

describe('buildBriefing golden (C.4)', () => {
  it('assembles ledger delta + open gates + failures + budget, capped', () => {
    const pr = insertPipelineRun('engineering'); cleanup.push(pr)
    const sid = insertStage(pr, 'awaiting_gate', 'approve-merge')
    db.prepare(`INSERT INTO pipeline_ledger (id, pipeline_run_id, stage_key, seq, ts, kind, actor, goal, detail, cost)
                VALUES (?, ?, 's1', 1, ?, 'transition', 'system', 'stage s1 → passed', NULL, NULL)`)
      .run(randomUUID(), pr, T - 1000)
    const body = buildBriefing('engineering', T - 3_600_000, T)
    expect(body).toContain('stage s1 → passed')            // ledger delta
    expect(body).toContain('approve-merge')                // open gate (stage key)
    expect(body).toContain(sid)                            // gate id — what resolve_gate takes
    expect(body).toContain('Budget')                       // budget section always present
    expect(body.length).toBeLessThanOrEqual(8_200)         // 8000 cap + truncation-suffix slack
  })
})

describe('wiring (C.4)', () => {
  it('DOMAIN_SUPERVISOR=0 → inert start; stop() unsubscribes', () => {
    try {
      process.env.DOMAIN_SUPERVISOR = '0'
      const stop = startDomainSupervisor()
      stop() // no throw
    } finally {
      // in finally so a throw can never leak '0' into later suites in the fork
      delete process.env.DOMAIN_SUPERVISOR
    }
    const stop2 = startDomainSupervisor({ cron: '*/15 * * * *' })
    stop2() // cron stopped + listeners off (structural: stop() calls the registry unsubscribers)
    // Post-stop sanity via the exported body: unknown pipeline id → no row written.
    onSupervisorPipelineTerminal(randomUUID(), 'completed')
    expect(briefingsFor('chief')).toHaveLength(0)
  })
})
