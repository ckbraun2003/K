/**
 * Continuous Agents — INT.3 end-to-end integration over the MERGED stack:
 * session engine (A.1/A.2, agent-sessions.ts) + mailbox/relay (B.1/B.2,
 * agent-mail.ts / message-relay.ts) + domains/supervision (C.1/C.4/C.5,
 * domains.ts / domain-supervisor.ts / mcp/mgmt.ts) + the K front door (A.4/B.4,
 * k-thread.ts) — five cross-module scenarios against the REAL DB:
 *  1. warm two-turn cycle (spawn → park → stdin into the SAME run);
 *  2. idle-demote → resume continuity (endSession → 'resumable' → --resume of
 *     the INIT-captured cli id);
 *  3. message-an-agent → relay wake → delivery → durable tagged turn, plus the
 *     A.4 forced-route path (askK queues a lead mailbox row the relay delivers);
 *  4. gate-parked → self-addressed domain briefing → relay delivery into the
 *     manager conversation → mgmt resolve_gate flips the stage;
 *  5. delegated-run report-back → queued to K → relay wake lands the durable
 *     turn on K's DEFAULT thread.
 *
 * Mock harness mirrors k-thread.test.ts / agent-sessions-live.test.ts:
 * '../src/supervisor.js' is partially mocked — startRun INSERTS a real runs row
 * (FK targets) mirroring the A.3 kind/session_id stamp from its opts;
 * sendInput/endSession/kill are plain fns; __testHooks stays REAL (...actual).
 * Lifecycle is driven via eventBus.emitRunUpdate. Isolated DB via
 * vitest.config.ts. Fixtures are ca-int3-/mock-int3- scoped; the K-side tables
 * are blanket-cleaned exactly like k-thread.test.ts's resetKState (this file
 * exercises the DEFAULT K thread, so it joins that posture). seedProfiles() is
 * NEVER called — every profile is guard-created (the global-roster invariant
 * belongs to profiles.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, agentSessionsDb, agentRunsDb, configDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, endSession, kill, reconcileStaleRuns, reconcileStaleKThreads } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async (_prompt: string, opts?: { kind?: string; sessionId?: string }) => {
      const id = `mock-int3-${uuid().slice(0, 8)}`
      // A.3 (D-127): mirror the real insertRun's kind/session_id stamp so the
      // chat-turn bookkeeping the spawn threads through startAgentRun → startRun
      // is assertable without a live process.
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, kind, session_id, created_at) VALUES (?, 'int3', '.', 'queued', ?, ?, ?)`,
      ).run(id, opts?.kind ?? 'job', opts?.sessionId ?? null, Date.now())
      return { id }
    }),
    sendInput: vi.fn(() => true),
    endSession: vi.fn(() => true),
    kill: vi.fn(() => false),
  }
})

const { getOrCreateConversation, ensureSession, sendToSession, demoteSession, sweepLiveSessionsOnBoot } =
  await import('../src/agent-sessions.js')
const {
  askK,
  appendTurn,
  ensureDefaultKThread,
  listKThreadTurns,
  reportDelegationBack,
  DEFAULT_K_THREAD_ID,
} = await import('../src/k-thread.js')
const { drainAgentMessages } = await import('../src/message-relay.js')
const { queueMessage } = await import('../src/agent-mail.js')
const { createDomain, getDomainById } = await import('../src/domains.js')
const {
  onSupervisorGateParked,
  resetDomainSupervisorState,
  DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR,
} = await import('../src/domain-supervisor.js')
const { mgmtTools } = await import('../src/mcp/mgmt.js')

type Row = Record<string, unknown>

// Suite-private fixture ids (never seeded-roster ids except the guard-created
// k-secretary/chief/lead-frontend the K scenarios structurally require).
const AGENT = 'ca-int3-agent' // the conversable orchestrator of scenarios 1-3
const MGR = 'ca-int3-mgr' // the chief-tier domain manager of scenario 4
const DOMAIN_ID = 'ca-int3-domain' // slugifyDomainName('CA Int3 Domain')

/** The raw agent_sessions row (snake_case) for direct persistence assertions. */
function sessionRow(id: string): Row | undefined {
  return agentSessionsDb.get.get(id) as Row | undefined
}

function msgRow(id: string): Row {
  return db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(id) as Row
}

/** The persistentSession opt startRun was last called with (mocked). */
function lastPersistentSession(): { key: string; sessionId: string; resume: boolean; homeDir?: string } {
  const call = vi.mocked(startRun).mock.calls.at(-1)!
  return (call[1] as { persistentSession?: { key: string; sessionId: string; resume: boolean; homeDir?: string } })
    .persistentSession!
}

/** Emit one run-lifecycle update the way the supervisor would. */
const update = (id: string, status: Run['status'], extra: Partial<Run> = {}): void =>
  eventBus.emitRunUpdate({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0, ...extra } as Run)

const mgmtTool = (name: string) => {
  const t = mgmtTools.find(x => x.name === name)
  if (!t) throw new Error(`mgmt tool ${name} not registered`)
  return t
}

function resetState() {
  // Listener hygiene (the agent-sessions-live A.6 posture): terminate every mock
  // run BEFORE the table wipes so dangling attachments/trackers unsubscribe from
  // the eventBus instead of accumulating across tests.
  for (const r of db.prepare(`SELECT id FROM runs WHERE id LIKE 'mock-int3-%'`).all() as Array<{ id: string }>) {
    update(r.id, 'killed')
  }
  // K-side blanket clean — the k-thread.test.ts resetKState posture (this file
  // touches the DEFAULT K thread + relay-created kt-<profile> conversations).
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare('DELETE FROM agent_messages').run()
  db.prepare(`DELETE FROM notifications WHERE event_key = 'message_failed'`).run()
  // Scoped: our profiles' activations + wake runs (agent_runs.run_id carries the
  // mock id for every relay wake, whichever profile it dispatched under).
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-int3-%' OR profile_id LIKE 'ca-int3-%'`).run()
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id LIKE 'mock-int3-%'`).run()
  // events.run_id FK → runs(id) has no cascade — events go before their runs.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-int3-%'`).run()
  // pipeline_ledger has NO FK to pipeline_runs — sweep it alongside the runs
  // (stages cascade with the run).
  db.prepare(`DELETE FROM pipeline_ledger WHERE pipeline_run_id LIKE 'ca-int3-pipe-%'`).run()
  db.prepare(`DELETE FROM pipeline_runs WHERE id LIKE 'ca-int3-pipe-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-int3-%'`).run()
}

// Guard-create everything (never seedProfiles()); delete in afterAll ONLY if we
// created it — a neighbor suite's seeded roster must survive us untouched.
const createdProfiles: string[] = []
let createdDomain = false

beforeAll(() => {
  const guards: Array<{ id: string; name: string; tier: 'secretary' | 'chief' | 'orchestrator' }> = [
    { id: AGENT, name: 'CA Int3 Agent', tier: 'orchestrator' },
    { id: MGR, name: 'CA Int3 Manager', tier: 'chief' },
    { id: 'k-secretary', name: 'K', tier: 'secretary' },
    { id: 'chief', name: 'Chief', tier: 'chief' },
    { id: 'lead-frontend', name: 'Frontend Lead', tier: 'orchestrator' },
  ]
  for (const g of guards) {
    if (!getProfile(g.id)) {
      createProfile({ id: g.id, name: g.name, tier: g.tier })
      createdProfiles.push(g.id)
    }
  }
  // Suite-private domain managed by our own chief-tier manager (the ops-c5 idiom
  // — never the seeded 'engineering'/'chief' pair).
  if (!getDomainById(DOMAIN_ID)) {
    createDomain({ name: 'CA Int3 Domain', managerProfileId: MGR })
    createdDomain = true
  }
})

beforeEach(() => {
  resetState()
  vi.mocked(startRun).mockClear()
  vi.mocked(sendInput).mockClear()
  vi.mocked(sendInput).mockReturnValue(true)
  vi.mocked(endSession).mockClear()
  vi.mocked(kill).mockClear()
})

afterAll(() => {
  resetState()
  db.prepare(`DELETE FROM app_config WHERE key = 'domain_wake_max_per_hour'`).run()
  if (createdDomain) db.prepare(`DELETE FROM domains WHERE id = ?`).run(DOMAIN_ID)
  for (const id of createdProfiles) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
})

// ── scenario 1 — warm two-turn cycle ─────────────────────────────────────────

describe('INT.3 scenario 1 — warm two-turn cycle', () => {
  it('first send spawns ONE interactive chat-turn run; a parked second send rides stdin into the SAME run', async () => {
    const t = getOrCreateConversation(AGENT)
    const s = ensureSession(AGENT, t.id)

    const r1 = await sendToSession(s.id, 'first')
    expect(r1.mode).toBe('spawned')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    // A.3 bookkeeping: the runs row carries kind 'chat-turn' + the owning session.
    const runRow = db.prepare('SELECT kind, session_id FROM runs WHERE id = ?').get(r1.runId) as Row
    expect(runRow).toEqual({ kind: 'chat-turn', session_id: s.id })

    // INIT captures the cli id; the park flips the session live.
    update(r1.runId, 'running', { cliSessionId: 'cli-int3-warm' })
    update(r1.runId, 'awaiting_input')
    expect(sessionRow(s.id)!.state).toBe('live')
    expect(sessionRow(s.id)!.cli_session_id).toBe('cli-int3-warm')

    const r2 = await sendToSession(s.id, 'second')
    expect(r2).toEqual({ mode: 'stdin', runId: r1.runId })
    expect(vi.mocked(sendInput)).toHaveBeenCalledWith(r1.runId, 'second')
    // NO second spawn, NO second runs row.
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const runs = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE id LIKE 'mock-int3-%'`).get() as { n: number }
    expect(runs.n).toBe(1)

    // The durable thread carries BOTH user turns, both linked to the live run.
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns.map(x => x.text).sort()).toEqual(['first', 'second'])
    for (const turn of userTurns) expect(turn.runId).toBe(r1.runId)
  })
})

// ── scenario 2 — idle-demote → resume continuity ─────────────────────────────

describe('INT.3 scenario 2 — idle-demote then resume continuity', () => {
  it("demoteSession('idle') ends the run + flips 'resumable' NOW; the next send RESUMES the captured cli id", async () => {
    const t = getOrCreateConversation(AGENT)
    const s = ensureSession(AGENT, t.id)
    const r1 = await sendToSession(s.id, 'warm me up')
    update(r1.runId, 'running', { cliSessionId: 'cli-int3-continuity' })
    update(r1.runId, 'awaiting_input')
    expect(sessionRow(s.id)!.state).toBe('live')

    demoteSession(s.id, 'idle')
    expect(vi.mocked(endSession)).toHaveBeenCalledWith(r1.runId)
    // Immediate flip — the row must not show 'live' while the CLI winds down.
    expect(sessionRow(s.id)!.state).toBe('resumable')

    // The graceful stdin close lands 'done' later — finalize confirms, keeps the id.
    update(r1.runId, 'done')
    expect(sessionRow(s.id)!.state).toBe('resumable')
    expect(sessionRow(s.id)!.cli_session_id).toBe('cli-int3-continuity')

    const r2 = await sendToSession(s.id, 'welcome back')
    expect(r2.mode).toBe('spawned')
    expect(r2.runId).not.toBe(r1.runId)
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2)
    // The resume rides the SAME cli session id the INIT captured — and carries
    // the bare body only (no transcript replay).
    expect(lastPersistentSession()).toMatchObject({
      key: t.id,
      sessionId: 'cli-int3-continuity',
      resume: true,
    })
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toBe('welcome back')
  })
})

// ── scenario 3 — message-an-agent → wake → delivery → durable turn ───────────

describe('INT.3 scenario 3 — mailbox wake delivery + the A.4 forced route', () => {
  it('queueMessage on an IDLE session → drain wakes ONE run, marks delivered, lands the tagged durable turn', async () => {
    const t = getOrCreateConversation(AGENT)
    ensureSession(AGENT, t.id) // idle (born 'stale')
    const m = queueMessage({
      toProfileId: AGENT,
      toThreadId: t.id,
      from: { kind: 'user' },
      body: 'please review the queue',
    })

    expect(await drainAgentMessages()).toBe(1)

    const row = msgRow(m.id)
    expect(row.status).toBe('delivered')
    expect(row.delivered_at).not.toBeNull()
    // ONE wake dispatch, under the target profile.
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const wakes = agentRunsDb.listRecentAgentRunsByProfile.all(AGENT, 10) as Row[]
    expect(wakes).toHaveLength(1)
    // The conversation's durable user turn carries the relay's provenance block.
    const userTurns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toContain('[message from user · normal] please review the queue')
  })

  it("askK forceRoute:'frontend' queues a lead-frontend mailbox row; the drain wakes the lead and delivers it", async () => {
    const result = await askK('anything', { forceRoute: 'frontend' })

    // A.4: a forced route queues a mailbox row — NOTHING dispatched at ask time.
    expect(result.runId).toBeNull()
    expect(vi.mocked(startRun)).not.toHaveBeenCalled()
    expect(typeof result.messageId).toBe('string')
    const before = msgRow(result.messageId!)
    expect(before).toMatchObject({
      to_profile_id: 'lead-frontend',
      to_thread_id: null, // the relay resolves the conversation at delivery time
      from_kind: 'user',
      body: 'anything',
      status: 'queued',
    })

    expect(await drainAgentMessages()).toBe(1)

    expect(msgRow(result.messageId!).status).toBe('delivered')
    // The wake dispatched under the LEAD profile…
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const leadWakes = agentRunsDb.listRecentAgentRunsByProfile.all('lead-frontend', 10) as Row[]
    expect(leadWakes).toHaveLength(1)
    // …and the lead's conversation carries the tagged durable turn.
    const leadThread = getOrCreateConversation('lead-frontend')
    const turns = listKThreadTurns(leadThread.id).filter(x => x.role === 'user')
    expect(turns.some(x => x.text.includes('[message from user · normal] anything'))).toBe(true)
  })
})

// ── scenario 4 — gate-parked → briefing → manager resolve_gate ───────────────

describe('INT.3 scenario 4 — gate park briefs the manager; the manager resolves the gate', () => {
  beforeEach(() => {
    resetDomainSupervisorState()
    configDb.set('domain_wake_max_per_hour', String(DEFAULT_DOMAIN_WAKE_MAX_PER_HOUR))
  })

  it('parked gate → ONE self-addressed urgent briefing → relay delivery → resolve_gate flips the stage', async () => {
    // A domain-attributed pipeline run with one gate stage parked awaiting-gate
    // (the domain-supervisor.test.ts fixture shape).
    const now = Date.now()
    const pr = `ca-int3-pipe-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO pipeline_runs (id, definition_id, project_id, title, cwd, base_commit, status, created_at, updated_at, completed_at, owner_profile_id, domain_id)
       VALUES (?, NULL, NULL, 'int3 gate pipeline', '.', 'base', 'running', ?, ?, NULL, NULL, ?)`,
    ).run(pr, now, now, DOMAIN_ID)
    const sid = uuid()
    db.prepare(
      `INSERT INTO pipeline_stages (id, pipeline_run_id, stage_key, kind, spec, status, created_at, updated_at)
       VALUES (?, ?, 'approve-merge', 'gate', '{}', 'awaiting_gate', ?, ?)`,
    ).run(sid, pr, now, now)

    // The supervisor's gate event path → ONE self-addressed manager briefing
    // (to == from == manager — the C.4 unforgeable discriminator), urgent.
    onSupervisorGateParked(pr, sid)
    const briefings = db
      .prepare(`SELECT * FROM agent_messages WHERE to_profile_id = ? AND from_profile_id = ?`)
      .all(MGR, MGR) as Row[]
    expect(briefings).toHaveLength(1)
    expect(briefings[0]).toMatchObject({
      from_kind: 'profile',
      priority: 'urgent',
      status: 'queued',
      to_thread_id: `kt-${MGR}`, // paired via getOrCreateConversation
    })
    expect(String(briefings[0].body)).toContain('[domain briefing')
    expect(String(briefings[0].body)).toContain(sid) // the gateId resolve_gate takes

    // The relay delivers it into the manager's conversation as a durable turn.
    expect(await drainAgentMessages()).toBe(1)
    expect(msgRow(String(briefings[0].id)).status).toBe('delivered')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1) // the manager's wake
    const turns = listKThreadTurns(`kt-${MGR}`).filter(x => x.role === 'user')
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toContain(`[message from ${MGR} · urgent]`)
    expect(turns[0].text).toContain('[domain briefing')

    // The manager (from its own run context — the mgmt-manager-tools ctx idiom)
    // resolves the gate: 'approve' → the stage flips 'passed', audit-stamped.
    const ctxRunId = `mock-int3-ctx-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'mgr', '.', 'running', ?)`,
    ).run(ctxRunId, Date.now())
    db.prepare(
      `INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
       VALUES (?, ?, ?, 'event', 'int3 gate', 'running', ?)`,
    ).run(uuid(), MGR, ctxRunId, Date.now())
    const out = await mgmtTool('resolve_gate').handler(
      { gateId: sid, decision: 'approve', note: 'int3 e2e' },
      { runId: ctxRunId },
    )
    expect(out).toMatchObject({ ok: true, gateId: sid, decision: 'approve' })
    const stage = db.prepare(`SELECT status, gate_resolved_by FROM pipeline_stages WHERE id = ?`).get(sid)
    expect(stage).toEqual({ status: 'passed', gate_resolved_by: MGR })
  })
})

// ── scenario 5 — report-back lands in K's conversation via the relay ─────────
// NB (SEAMS#1 m3): this seeds NO agent_runs activation row for the delegated run,
// so the mgmt-report C.5 dual-write is (deliberately) skipped and the INT.2
// de-dup branch is NOT traversed here — the terminal report-back quotes the
// report (the degradation path). The de-dup itself is unit-locked in
// k-thread.test.ts ("DE-DUPS the C.5 dual-write…").

describe("INT.3 scenario 5 — delegated report-back reaches K's DEFAULT thread through the relay", () => {
  it("the chief run's terminal queues the report-back to k-secretary; the drain wakes K and lands the tagged durable turn", async () => {
    ensureDefaultKThread()
    // Seed a delegated chief run exactly like k-thread.test.ts's seedDelegatedRun:
    // a real runs row + the linked delegating user turn + the report-back seam.
    const runId = `mock-int3-del-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'chief', '.', 'running', ?)`,
    ).run(runId, Date.now())
    appendTurn(DEFAULT_K_THREAD_ID, 'user', 'implement the new feature', runId)
    reportDelegationBack(DEFAULT_K_THREAD_ID, runId)

    // The Chief files its mgmt report, then the run terminates → B.4 queues ONE
    // message to K's delegating thread (no direct thread append).
    await mgmtTool('report').handler({ body: 'PR #42 opened; CI green' }, { runId })
    update(runId, 'done')

    const msgs = db.prepare(`SELECT * FROM agent_messages ORDER BY created_at ASC, id ASC`).all() as Row[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      to_profile_id: 'k-secretary',
      to_thread_id: DEFAULT_K_THREAD_ID,
      from_kind: 'profile',
      from_profile_id: 'chief',
      status: 'queued',
      provenance_run_id: runId,
    })
    expect(String(msgs[0].body)).toContain('Chief (delegation completed) reported: PR #42 opened; CI green')

    // The relay delivers: K wakes (ONE dispatch under k-secretary) and the
    // DEFAULT thread gains the durable tagged user turn.
    expect(await drainAgentMessages()).toBe(1)
    expect(msgRow(String(msgs[0].id)).status).toBe('delivered')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const kWakes = agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 10) as Row[]
    expect(kWakes).toHaveLength(1)

    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(x => x.role === 'user')
    const reportTurn = userTurns.find(x => x.text.includes('[message from chief · normal]'))
    expect(reportTurn).toBeDefined()
    expect(reportTurn!.text).toContain('Chief (delegation completed) reported: PR #42 opened; CI green')
    // The delivered turn is linked to the wake run that consumed it.
    expect(reportTurn!.runId).toBe(kWakes[0].run_id)
  })
})

// ── scenario 6 — crash recovery: relay hold → boot reconciles → delivery ─────
// SEAMS#1's most-valuable-missing-test: the never-permanently-strand-a-message
// guarantee rests on the CHAIN relay-in-flight-hold → boot reconciles → next
// drain, across the Lane B / pre-existing-boot-code boundary. Each link is
// unit-tested; this locks the chain.

describe('INT.3 scenario 6 — a crash-stranded active run cannot permanently strand the mailbox (SEAMS#1)', () => {
  it('drain HOLDS on the stranded non-terminal run; the boot chain clears it; the NEXT drain delivers', async () => {
    const t = getOrCreateConversation(AGENT)
    ensureSession(AGENT, t.id)
    // A crash left a NON-terminal run behind: row 'running', thread pointing at
    // it, NO live process (activeProcesses died with the old supervisor).
    const stranded = `mock-int3-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'int3', '.', 'running', ?)`,
    ).run(stranded, Date.now())
    db.prepare(`UPDATE k_threads SET active_run_id = ? WHERE id = ?`).run(stranded, t.id)

    const m = queueMessage({
      toProfileId: AGENT, toThreadId: t.id,
      from: { kind: 'profile', profileId: 'k-secretary' }, body: 'stranded?',
    })
    // The W0 in-flight guard HOLDS (non-terminal active run): no delivery, no
    // false 'failed' — the row waits.
    expect(await drainAgentMessages()).toBe(0)
    expect(msgRow(m.id).status).toBe('queued')
    expect(vi.mocked(startRun)).not.toHaveBeenCalled()

    // The boot chain, in index.ts start() order — all REAL functions (the mock
    // spreads ...actual): stuck runs → 'interrupted'; stale thread pointers
    // cleared; stranded-'live' session rows swept.
    reconcileStaleRuns()
    reconcileStaleKThreads()
    sweepLiveSessionsOnBoot()
    expect((db.prepare(`SELECT status FROM runs WHERE id = ?`).get(stranded) as Row).status).toBe('interrupted')

    // The hold is gone — the next tick wakes and delivers.
    expect(await drainAgentMessages()).toBe(1)
    expect(msgRow(m.id).status).toBe('delivered')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    const turns = listKThreadTurns(t.id).filter(x => x.role === 'user')
    expect(turns.some(x => x.text.includes('[message from k-secretary · normal] stranded?'))).toBe(true)
  })
})
