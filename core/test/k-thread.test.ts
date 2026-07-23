/**
 * k-thread.ts — the K front-door runtime (P5.1c, D-023 → D-126 / Continuous
 * Agents A.4). askK now RIDES THE SESSION ENGINE (agent-sessions.ts): a live
 * parked run receives the message over stdin (warm), else an interactive session
 * run is spawned; the deterministic router survives as a display PREVIEW only,
 * and a FORCED route queues a mailbox message (agent_messages) instead of
 * dispatching anything.
 *
 * Mock harness mirrors agent-sessions-live.test.ts: '../src/supervisor.js' is
 * partially mocked — startRun INSERTS a real runs row (k_threads.active_run_id,
 * k_thread_turns.run_id and agent_runs.run_id all FK → runs(id)) and mirrors the
 * A.3 kind/session_id stamp from its opts; sendInput/endSession/kill are plain
 * fns. Lifecycle is driven via eventBus.emitRunUpdate. Isolated DB via
 * vitest.config.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { KForceRouteSchema } from '@k/shared'
import { db, agentRunsDb, pipelineDb, domainsDb, workflowDefsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, kill, __testHooks } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { mgmtTools } from '../src/mcp/mgmt.js'
import { maybeFinalizePipeline } from '../src/pipeline-engine.js'
import { getOrCreateConversation } from '../src/agent-sessions.js'
import { ORG_DEFAULT_PROFILE_ID } from '../src/plan-gate.js'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real runs
// row (the K thread + agent_runs rows FK → runs(id)) and it mirrors the real
// insertRun's kind/session_id stamp (A.3, D-127) so undoSessionRun's
// runs.session_id fallback is exercisable. sendInput/endSession/kill are plain
// mocks (the agent-sessions-live harness); __testHooks stays REAL (...actual).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async (_prompt: string, opts?: { kind?: string; sessionId?: string }) => {
      const id = `mock-k-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, kind, session_id, created_at) VALUES (?, 'k', '.', 'queued', ?, ?, ?)`,
      ).run(id, opts?.kind ?? 'job', opts?.sessionId ?? null, Date.now())
      return { id }
    }),
    sendInput: vi.fn(() => true),
    endSession: vi.fn(() => true),
    kill: vi.fn(() => false),
  }
})

const {
  askK,
  undoK,
  appendTurn,
  ensureDefaultKThread,
  getKThread,
  listKThreadTurns,
  renderSeed,
  reportDelegationBack,
  DEFAULT_K_THREAD_ID,
  FORCE_ROUTE_PROFILE,
  continueLeadOutcomeToK,
  continuePipelineOutcomeToK,
  resolveKDelegationThread,
  summarizeChiefLeadContinuation,
} = await import('../src/k-thread.js')

type Row = Record<string, unknown>

/** The raw K session row (k-secretary + thread pair) — where the session engine
 *  persists cli_session_id/state now (agent_sessions, NOT k_threads). */
function kSessionRow(threadId = DEFAULT_K_THREAD_ID): Row | undefined {
  return db
    .prepare(`SELECT * FROM agent_sessions WHERE profile_id = 'k-secretary' AND thread_id = ?`)
    .get(threadId) as Row | undefined
}

/** The K session's persisted CLI session id (NULL until an ask establishes one). */
function sessionCliId(threadId = DEFAULT_K_THREAD_ID): string | null {
  return (kSessionRow(threadId)?.cli_session_id as string | null | undefined) ?? null
}

/** The persistentSession opt startRun was last called with. */
function lastPersistentSession(): { key: string; sessionId: string; resume: boolean; homeDir?: string } | undefined {
  const call = vi.mocked(startRun).mock.calls.at(-1)!
  return (call[1] as { persistentSession?: { key: string; sessionId: string; resume: boolean; homeDir?: string } })
    .persistentSession
}

/** Emit one run-lifecycle update the way the supervisor would. */
const update = (id: string, status: Run['status'], extra: Partial<Run> = {}): void =>
  eventBus.emitRunUpdate({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0, ...extra } as Run)

/** All queued/delivered agent_messages rows, oldest-first (B.4: report-backs are messages). */
function queuedMessages(): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM agent_messages ORDER BY created_at ASC, id ASC`).all() as Array<
    Record<string, unknown>
  >
}


function resetKState() {
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  // A.4 forced routes + B.4 report-backs both land in the mailbox — clear it like
  // the thread tables above (this file already blanket-cleans its k_* tables;
  // agent_messages joins that set).
  db.prepare('DELETE FROM agent_messages').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('k-secretary', 'chief', 'ca-b-lead-prof')`).run()
  // mgmt reports the delegation report-back tests file against the mock chief run —
  // clear them before the runs (run_id → runs(id) ON DELETE SET NULL, but tidy anyway).
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id LIKE 'mock-k-%'`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  // The pipeline-continuation fixtures (B.4 case 4): dispatches first (loose refs),
  // then the pipeline runs (stages cascade), then the mock runs below.
  db.prepare(`DELETE FROM pipeline_dispatches WHERE pipeline_id = 'ca-b4-def'`).run()
  db.prepare(`DELETE FROM pipeline_runs WHERE id LIKE 'mock-k-pipe-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%'`).run()
}

// Guard-create the 'k-secretary' profile askK's session engine activates — do NOT
// call seedProfiles(): the durable roster is a global invariant profiles.test.ts
// asserts on a clean DB. (No 'chief' profile needed since A.4 — askK never
// dispatches the Chief; forced routes queue mailbox rows, no dispatch at all.)
let createdKSecretary = false
let createdChief = false
let createdLeadProf = false
let createdDomainMgr = false
let createdDomain = false
let createdWorkflowDef = false

/** Lane E fixture: a real domain manager + domain + workflow-definition (domain_id
 *  stamped), so continuePipelineOutcomeToK's default-orchestrator redirect has a real
 *  domainForPipelineDef(defId)?.managerProfileId to resolve — the SAME resolution
 *  routes/pipelines.ts's "Observed by" default uses. */
const DOMAIN_MGR_PROFILE_ID = 'ca-e-domain-mgr'
const DOMAIN_ID = 'ca-e-domain'
const DOMAIN_DEF_ID = 'ca-e-def'

beforeAll(() => {
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
  // B.4: report-backs queue messages FROM the chief / the lead's own profile — those
  // sender profiles must exist even though askK itself never dispatches them (A.4).
  if (!getProfile('chief')) {
    createProfile({ id: 'chief', name: 'Chief', tier: 'chief' })
    createdChief = true
  }
  // B.4 case 3: a lead profile the continuation resolves as the REPORTING sender via
  // the lead run's agent_runs row (agent_runs.profile_id FK → agent_profiles).
  if (!getProfile('ca-b-lead-prof')) {
    createProfile({ id: 'ca-b-lead-prof', name: 'CA-B Lead', tier: 'orchestrator' })
    createdLeadProf = true
  }
  // Lane E: the domain-manager redirect fixture (see DOMAIN_MGR_PROFILE_ID doc above).
  if (!getProfile(DOMAIN_MGR_PROFILE_ID)) {
    createProfile({ id: DOMAIN_MGR_PROFILE_ID, name: 'CA-E Domain Mgr', tier: 'orchestrator' })
    createdDomainMgr = true
  }
  if (!domainsDb.get.get(DOMAIN_ID)) {
    domainsDb.create.run({
      id: DOMAIN_ID, name: 'CA-E Domain', description: null,
      managerProfileId: DOMAIN_MGR_PROFILE_ID, createdAt: Date.now(),
    })
    createdDomain = true
  }
  if (!workflowDefsDb.getWorkflowDefRow.get(DOMAIN_DEF_ID)) {
    workflowDefsDb.insertWorkflowDef.run({
      id: DOMAIN_DEF_ID, name: 'CA-E Def', roles: '[]', promptScaffold: 'x', crossProject: 0, createdAt: Date.now(),
    })
    // domain_id has no named-param slot on insertWorkflowDef (added later via
    // migration, mirrors domains.ts::stampSeededDomainMemberships' own UPDATE).
    db.prepare(`UPDATE workflow_definitions SET domain_id = ? WHERE id = ?`).run(DOMAIN_ID, DOMAIN_DEF_ID)
    createdWorkflowDef = true
  }
})

beforeEach(() => {
  resetKState()
  vi.mocked(startRun).mockClear()
  vi.mocked(sendInput).mockClear()
  vi.mocked(kill).mockClear()
})

afterAll(() => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  if (createdChief) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
  if (createdLeadProf) db.prepare(`DELETE FROM agent_profiles WHERE id = 'ca-b-lead-prof'`).run()
  // Lane E fixture teardown — reverse creation order (workflow def → domain → profile).
  if (createdWorkflowDef) db.prepare(`DELETE FROM workflow_definitions WHERE id = ?`).run(DOMAIN_DEF_ID)
  if (createdDomain) db.prepare(`DELETE FROM domains WHERE id = ?`).run(DOMAIN_ID)
  if (createdDomainMgr) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(DOMAIN_MGR_PROFILE_ID)
})

// ── routeForMessage (pure preview) ────────────────────────────────────────────

describe('routeForMessage', () => {
  // Re-import the pure helper straight from @k/shared (no DB / no mock needed).
  it('logistics — no engineering signal → K handles directly', async () => {
    const { routeForMessage } = await import('@k/shared')
    for (const msg of ['remind me to call mom', "what's on my calendar"]) {
      const r = routeForMessage(msg)
      expect(r.target).toBe('logistics')
      expect(r.escalates).toBe(false)
      expect(r.label).toBe('K handles directly')
    }
  })

  it('chief — generic engineering keyword, no named lead', async () => {
    const { routeForMessage } = await import('@k/shared')
    const r = routeForMessage('fix a failing test')
    expect(r.target).toBe('chief')
    expect(r.escalates).toBe(true)
    expect(r.label).toBe('Chief')
  })

  it('routes each named lead with its label + escalates=true', async () => {
    const { routeForMessage } = await import('@k/shared')
    const cases: Array<[string, string, string]> = [
      ['update the react component', 'frontend', 'Chief → Frontend Lead'],
      ['add an api endpoint', 'backend', 'Chief → Backend Lead'],
      ['fix the ci pipeline', 'systems', 'Chief → Systems Lead'],
      ['rotate the leaked credential', 'security', 'Chief → Security Lead'],
      ['debug the dns proxy', 'network', 'Chief → Network Lead'],
    ]
    for (const [msg, target, label] of cases) {
      const r = routeForMessage(msg)
      expect(r.target).toBe(target)
      expect(r.label).toBe(label)
      expect(r.escalates).toBe(true)
    }
  })

  it('logistics precedence — a clear personal-logistics intent wins over embedded engineering keywords', async () => {
    const { routeForMessage } = await import('@k/shared')
    // [message, expected target, expected escalates] — the logistics markers
    // (remind/note/schedule/add-to-my-list/what's-on-my) take precedence over any
    // engineering keyword inside the message; a message WITHOUT a logistics marker
    // still routes through the lead rules / engineering fallback unchanged.
    const cases: Array<[string, string, boolean]> = [
      ['remind me to fix the fence', 'logistics', false],
      ['set a reminder for the dentist', 'logistics', false],
      ['fix the login bug', 'chief', true],
      ['the api endpoint is broken', 'backend', true],
      ['note about my server bill', 'logistics', false],
      ['take a note: renew the domain', 'logistics', false],
      ['schedule a meeting about the deploy', 'logistics', false],
      ['add a calendar appointment for friday', 'logistics', false],
      ['add fix the auth bug to my work items', 'logistics', false],
      ["what's on my list", 'logistics', false],
      ["what's on my calendar today", 'logistics', false],
      // One per lead rule: no logistics marker → the lead rules still win.
      ['restyle the css grid', 'frontend', true],
      ['the database migration failed', 'backend', true],
      ['the deploy pipeline is red', 'systems', true],
      ['patch the cve in the parser', 'security', true],
      ['tls handshake latency spiked', 'network', true],
    ]
    for (const [msg, target, escalates] of cases) {
      const r = routeForMessage(msg)
      expect(r.target, `route for "${msg}"`).toBe(target)
      expect(r.escalates, `escalates for "${msg}"`).toBe(escalates)
    }
  })
})

// ── K_SEED_INSTRUCTION — store disambiguation (F-058) ─────────────────────────

describe('renderSeed store disambiguation (F-058)', () => {
  it('the reseed instruction maps each capture intent to its OWN store tool', () => {
    ensureDefaultKThread()
    // renderSeed survives as the documented stale-path fallback (Lane B) — its
    // trailing K_SEED_INSTRUCTION must still steer K to pick the right store by
    // intent instead of defaulting everything to a work item:
    //   note / FYI / "jot this down" → note_add (Notes)
    //   schedule / remind me / a time → event_add or reminder_add (Schedule)
    //   task / to-do / "track this"  → work_item_create scope='personal' (Your work)
    const seed = renderSeed(DEFAULT_K_THREAD_ID, 'add a note')
    expect(seed).toContain('note_add')
    expect(seed).toContain('event_add')
    expect(seed).toContain('reminder_add')
    expect(seed).toContain('work_item_create')
    expect(seed).toContain("scope='personal'")
    // The three surfaces are named so the intent→tool mapping is explicit, and the
    // ambiguous-note case is called out (a NOTE, not a task).
    expect(seed).toMatch(/Notes/)
    expect(seed).toMatch(/Schedule/)
    expect(seed).toMatch(/not a task/i)
  })
})

// ── askK — session-engine dispatch (A.4, D-126) ───────────────────────────────

describe('askK — rides the session engine (A.4)', () => {
  it('spawns an INTERACTIVE session run keyed on the resolved thread; captures answers; persists the CLI session on the agent_sessions row', async () => {
    const result = await askK('remind me to prep the meeting notes')

    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(result.kThreadId).toBe(DEFAULT_K_THREAD_ID)
    expect(typeof result.agentRunId).toBe('string')

    // The session engine's spawn: interactive + persistentSession keyed on the
    // thread, establish (resume=false), the session row's homeDir threaded.
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    expect(String(call[0])).toContain('You: remind me to prep the meeting notes')
    expect((call[1] as { interactive?: boolean }).interactive).toBe(true)
    const ps = lastPersistentSession()!
    expect(ps).toMatchObject({ key: DEFAULT_K_THREAD_ID, resume: false })
    expect(ps.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(typeof ps.homeDir).toBe('string')
    // A.3: the spawn stamps the owning agent_sessions row onto the run.
    expect((call[1] as { sessionId?: string }).sessionId).toBe(String(kSessionRow()!.id))

    // EXACTLY ONE 'user' turn (sendToSession owns the durable append — askK must
    // not double-append), linked to the run.
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('remind me to prep the meeting notes')
    expect(userTurns[0].runId).toBe(result.runId)

    // The thread points at the in-flight run until it terminates.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBe(result.runId)

    // agentRunId is the agent_runs tracking id of the session run.
    const kRows = agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 10) as Row[]
    expect(kRows).toHaveLength(1)
    expect(kRows[0].trigger).toBe('user-message')
    expect(kRows[0].run_id).toBe(result.runId)
    expect(result.agentRunId).toBe(kRows[0].id)

    // Answer capture still rides captureAnswers: assistant events fold into one
    // 'k' turn at the terminal, the thread clears, and the SESSION row now carries
    // the persisted CLI session id (belt-and-suspenders establish stamp).
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 1, type: 'assistant', ts: Date.now(), text: 'Hello' })
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 2, type: 'assistant', ts: Date.now(), text: 'from K' })
    update(result.runId!, 'done')

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('Hello\nfrom K')
    expect(kTurns[0].runId).toBe(result.runId)

    const thread = getKThread(DEFAULT_K_THREAD_ID)!
    expect(thread.activeRunId).toBeNull()
    expect(thread.status).toBe('idle')
    expect(sessionCliId()).toBe(ps.sessionId)
    expect(kSessionRow()!.state).toBe('resumable')
  })

  it('a failed FIRST ask (non-done terminal, no INIT) leaves the session stale with NO id — the next ask establishes fresh', async () => {
    const result = await askK('note the errands')
    update(result.runId!, 'error')
    expect(sessionCliId()).toBeNull()
    expect(kSessionRow()!.state).toBe('stale')

    await askK('note the errands again')
    expect(lastPersistentSession()!.resume).toBe(false)
  })

  it('a dispatch throw propagates: the durable user turn stays, no ack/reply turn, no attachment left — the next ask retries the establish', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('spawn failed'))
    await expect(askK('note the errands')).rejects.toThrow('spawn failed')

    // Durable-before-dispatch: the user turn survives the failed spawn; nothing
    // else was appended (no ack, no reply).
    const turns = listKThreadTurns(DEFAULT_K_THREAD_ID)
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('user')

    // No attachment was left behind — the next ask simply retries the establish
    // (spawned fresh, not stdin into a phantom run).
    const retry = await askK('note the errands again')
    expect(retry.warm).toBe(false)
    expect(retry.runId).toMatch(/^mock-k-run-/)
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2)
  })

  it('captures ONLY the new assistant text at each boundary (seq-windowed, two boundaries)', async () => {
    const result = await askK('note the grocery list')

    // Boundary 1: two assistant events → one folded 'k' turn.
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 1, type: 'assistant', ts: Date.now(), text: 'turn one a' })
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 2, type: 'assistant', ts: Date.now(), text: 'turn one b' })
    update(result.runId!, 'awaiting_input')

    let kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('turn one a\nturn one b')

    // Boundary 2 (terminal): only the NEW assistant event (seq 3) is captured — the
    // seq window advanced past 1-2, so turn two must not re-include turn one's text.
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 3, type: 'assistant', ts: Date.now(), text: 'turn two only' })
    update(result.runId!, 'done')

    kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(2)
    // Content assertions, not positional: both turns can share a created_at ms and
    // listTurns tie-breaks on random uuid — order within the ms is not deterministic.
    const texts = kTurns.map(t => t.text)
    expect(texts).toContain('turn one a\nturn one b')
    expect(texts).toContain('turn two only')
  })

  it('NO auto-delegation — an escalating classifier hit stays a k-secretary session run; the route survives as a display-only preview', async () => {
    const result = await askK('refactor the api backend')

    // The PREVIEW still says backend (display-only)…
    expect(result.route.target).toBe('backend')
    expect(result.route.escalates).toBe(true)

    // …but the dispatch is K's OWN session run: k-secretary, NOT the Chief.
    const kRows = agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 10) as Row[]
    expect(kRows).toHaveLength(1)
    expect(kRows[0].run_id).toBe(result.runId)
    expect(agentRunsDb.listRecentAgentRunsByProfile.all('chief', 10)).toHaveLength(0)

    // And it rode the session engine (persistentSession threaded, thread-keyed).
    expect(lastPersistentSession()).toMatchObject({ key: result.kThreadId, resume: false })
  })

  it('WARM second ask — a parked session run receives the message over stdin: same runId, startRun once, warm:true', async () => {
    const first = await askK('remind me to prep the retro')
    update(first.runId!, 'awaiting_input') // park → the attachment is live

    const second = await askK('again with more detail', { threadId: first.kThreadId })

    expect(second.warm).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(typeof second.agentRunId).toBe('string')
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendInput)).toHaveBeenCalledWith(first.runId, 'again with more detail')

    // The second durable user turn exists and is linked to the LIVE run.
    const userTurns = listKThreadTurns(first.kThreadId).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(2)
    expect(userTurns.find(t => t.text === 'again with more detail')!.runId).toBe(first.runId)

    // Warm sends count as thread ACTIVITY: thread-list ordering and the
    // no-threadId ask default both key off k_threads.updated_at, so a stdin
    // delivery must bump it (quality-review m2 lock).
    db.prepare('UPDATE k_threads SET updated_at = 1 WHERE id = ?').run(first.kThreadId)
    const third = await askK('and one more thing', { threadId: first.kThreadId })
    expect(third.warm).toBe(true)
    const row = db.prepare('SELECT updated_at FROM k_threads WHERE id = ?').get(first.kThreadId) as Row
    expect(Number(row.updated_at)).toBeGreaterThan(1)
  })
})

// ── resolveAskThread — ownership guard (defense-in-depth) ──────────────────────

describe('askK — resolveAskThread ownership guard', () => {
  it('an explicit threadId owned by ANOTHER profile 404s exactly like an unknown one — no turn appended', async () => {
    const foreign = getOrCreateConversation('chief')
    await expect(askK('hello', { threadId: foreign.id })).rejects.toThrow(/not found/i)
    // Rejected BEFORE any write — the foreign thread stays untouched.
    expect(listKThreadTurns(foreign.id)).toHaveLength(0)
  })

  it('a K-owned explicit threadId still resolves normally (no regression)', async () => {
    const first = await askK('first message')
    const second = await askK('second message', { threadId: first.kThreadId })
    expect(second.kThreadId).toBe(first.kThreadId)
    expect(listKThreadTurns(first.kThreadId).filter(t => t.role === 'user')).toHaveLength(2)
  })

  it('an ask with NO threadId never adopts another profile\'s more-recent thread — the fallback stays k-secretary-scoped', async () => {
    // Establish a K thread, THEN make a foreign profile's conversation the
    // most-recently-updated row in k_threads (getOrCreateConversation inserts at now).
    const kThread = await askK('k first')
    const foreign = getOrCreateConversation('chief')
    // A fresh unscoped ask must resolve a K-OWNED thread, not chief's most-recent one.
    const next = await askK('k second, no explicit thread')
    expect(next.kThreadId).not.toBe(foreign.id)
    expect(next.kThreadId).toBe(kThread.kThreadId)
    const owner = db.prepare('SELECT profile_id FROM k_threads WHERE id = ?').get(next.kThreadId) as { profile_id: string }
    expect(owner.profile_id).toBe('k-secretary')
  })
})

// ── askK — resumable session (session-engine establish/resume) ────────────────

describe('askK — resumable session (agent_sessions establish/resume)', () => {
  /** Run a first ask to completion so the SESSION row carries a persisted id. */
  async function establishSession(msg = 'what is on my calendar'): Promise<string> {
    const first = await askK(msg)
    update(first.runId!, 'done')
    const sid = sessionCliId()
    expect(sid).toBeTruthy()
    return sid!
  }

  it('a SECOND ask RESUMES the persisted session and sends ONLY the new message (no transcript replay)', async () => {
    const sessionId = await establishSession()

    const second = await askK('add lunch with Sam at noon')
    expect(second.warm).toBe(false) // spawned (the first run terminated) — a resume, not stdin
    expect(second.runId).not.toBe(undefined)

    // startRun got resume=true + the SAME session id; the prompt is ONLY the new
    // message — no `You:` transcript replay.
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    expect(String(call[0])).toBe('add lunch with Sam at noon')
    expect(String(call[0])).not.toContain('You:')
    expect(String(call[0])).not.toContain('what is on my calendar')
    expect(lastPersistentSession()).toMatchObject({ key: DEFAULT_K_THREAD_ID, sessionId, resume: true })
  })

  it('a FIRST ask (no session yet) establishes with the neutral transcript seed', async () => {
    const r = await askK('note the milk')
    expect(r.warm).toBe(false)
    expect(lastPersistentSession()!.resume).toBe(false)
    // The session engine's establish seed carries the current ask as a You: line.
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toContain('You: note the milk')
    // __testHooks stays imported/exercised elsewhere; keep the reference honest.
    expect(typeof __testHooks.initSeq).toBe('function')
  })
})

// ── appendTurn visibility invariant (final-review fix) ────────────────────────

describe('appendTurn un-archives on activity (visibility invariant)', () => {
  it('a terminal K reply landing on an archived thread un-archives it — the reply is never hidden', async () => {
    // A K run is in flight on the default thread…
    const result = await askK('note the errands')
    // …then the operator ARCHIVES the thread while the run is still running.
    db.prepare('UPDATE k_threads SET archived_at = ? WHERE id = ?').run(Date.now(), DEFAULT_K_THREAD_ID)
    expect(getKThread(DEFAULT_K_THREAD_ID)!.archivedAt).not.toBeNull()

    // K's answer lands on terminal (captureAnswers → appendTurn).
    eventBus.emitEvent({ id: uuid(), runId: result.runId!, seq: 1, type: 'assistant', ts: Date.now(), text: 'Noted.' })
    update(result.runId!, 'done')

    // The reply un-archived the thread: archived_at is cleared and it is back in the DEFAULT
    // (non-archived) list — so the operator actually sees K's answer instead of it landing hidden.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.archivedAt).toBeNull()
    const defaultList = db.prepare('SELECT id FROM k_threads WHERE archived_at IS NULL').all() as Array<{ id: string }>
    expect(defaultList.some(t => t.id === DEFAULT_K_THREAD_ID)).toBe(true)
  })
})

// ── askK — forced routes queue mailbox messages (A.4, D-126) ──────────────────

/** File a mgmt report against `runId` exactly as an agent's mgmt `report` tool does. */
function fileChiefReport(runId: string, body: string) {
  const report = mgmtTools.find(t => t.name === 'report')!
  return report.handler({ body }, { runId })
}

describe('askK — forceRoute queues a mailbox message (no dispatch)', () => {
  it('forceRoute:frontend → an agent_messages row for lead-frontend, a durable user turn + k ack, runId/agentRunId null', async () => {
    const result = await askK('ship the fix', { forceRoute: 'frontend' })

    // NOTHING was dispatched — no run, no agent activation of any profile.
    expect(vi.mocked(startRun)).not.toHaveBeenCalled()
    expect(result.runId).toBeNull()
    expect(result.agentRunId).toBeNull()
    expect(result.warm).toBe(false)
    expect(result.route.target).toBe('frontend')
    expect(typeof result.messageId).toBe('string')

    // The queued mailbox row (status takes the DDL default 'queued').
    const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(result.messageId!) as Row
    expect(row).toMatchObject({
      to_profile_id: 'lead-frontend',
      to_thread_id: null,
      from_kind: 'user',
      from_profile_id: null,
      body: 'ship the fix',
      priority: 'normal',
      status: 'queued',
      provenance_run_id: null,
    })

    // Durable user turn + a 'k' ack turn naming the queue target.
    const turns = listKThreadTurns(result.kThreadId)
    const userTurns = turns.filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('ship the fix')
    const ack = turns.find(t => t.role === 'k')!
    expect(ack.text).toContain('Queued for')
    expect(ack.text).toContain(result.route.label)
    expect(ack.text).toContain('ship the fix')
  })

  it("forceRoute:'chief' maps to profile 'chief'; the target→profile map is total (chief + 5 leads)", async () => {
    const result = await askK('rebalance the leads', { forceRoute: 'chief' })
    const row = db.prepare('SELECT to_profile_id FROM agent_messages WHERE id = ?').get(result.messageId!) as Row
    expect(row.to_profile_id).toBe('chief')

    expect(FORCE_ROUTE_PROFILE).toEqual({
      chief: 'chief',
      frontend: 'lead-frontend',
      backend: 'lead-backend',
      systems: 'lead-systems',
      security: 'lead-security',
      network: 'lead-network',
    })
    expect(Object.keys(FORCE_ROUTE_PROFILE).sort()).toEqual([...KForceRouteSchema.options].sort())
  })
})

// ── askK — model power control (C2, on the session path) ─────────────────────

describe('askK — model power control on the session path', () => {
  it('an explicit model on a FIRST ask reaches startRun (interactive establish)', async () => {
    await askK('note the grocery list', { model: 'claude-opus-4-8' })
    const lastCall = vi.mocked(startRun).mock.calls.at(-1)!
    expect(lastCall[1]).toMatchObject({ model: 'claude-opus-4-8', persistentSession: { resume: false } })
    expect((lastCall[1] as { interactive?: boolean }).interactive).toBe(true)
  })

  it('an explicit model on a RESUME ask still resumes the SAME session under that model (no continuity lost)', async () => {
    const first = await askK('note the follow-ups')
    update(first.runId!, 'done')
    const sessionId = sessionCliId()!

    // A LOGISTICS follow-up so the classifier preview stays non-escalating.
    const second = await askK('what else is on my calendar', { model: 'claude-opus-4-8' })
    expect(second.warm).toBe(false)
    expect(second.runId).not.toBe(first.runId)
    const lastCall = vi.mocked(startRun).mock.calls.at(-1)!
    expect(lastCall[1]).toMatchObject({ model: 'claude-opus-4-8', persistentSession: { sessionId, resume: true } })
  })
})

// ── reportDelegationBack — the report-back seam (B.4 queues, A.4 wires direct) ─

describe('reportDelegationBack — delegated outcome QUEUED as an agent message (B.4)', () => {
  /** Seed an FK-valid delegated run + its run-linked ask turn, and wire the seam
   *  directly (askK no longer delegates — A.4/D-126; B.4 owns the live callers). */
  function seedDelegatedRun(msg: string): string {
    ensureDefaultKThread()
    const runId = `mock-k-run-del-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'chief', '.', 'running', ?)`,
    ).run(runId, Date.now())
    appendTurn(DEFAULT_K_THREAD_ID, 'user', msg, runId)
    reportDelegationBack(DEFAULT_K_THREAD_ID, runId)
    return runId
  }

  it("QUEUES the Chief's report as an agent message on terminal — no direct k turn (B.4)", async () => {
    const runId = seedDelegatedRun('implement the new feature')

    // The Chief files a status report up the chain (the mgmt `report` tool), then its
    // run reaches terminal — the report-back is now a MESSAGE from the Chief to K's
    // delegating thread (the relay delivers it; no bespoke appendTurn).
    fileChiefReport(runId, 'PR #42 opened; CI green')
    const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
    update(runId, 'done')

    // ONE queued agent_messages row, addressed to K's originating thread, from the Chief.
    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to_profile_id).toBe('k-secretary')
    expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)
    expect(msgs[0].from_kind).toBe('profile')
    expect(msgs[0].from_profile_id).toBe('chief')
    expect(msgs[0].provenance_run_id).toBe(runId)
    expect(msgs[0].status).toBe('queued')
    expect(String(msgs[0].body)).toContain('Chief (delegation completed)')
    expect(String(msgs[0].body)).toContain('PR #42 opened')

    // NO new turn was appended by the report-back itself — the relay's wake path
    // lands the durable turn. (The seeded user ask is the only turn; the old
    // "Routing to …" ack premise is void since A.4 — askK never delegates.)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)
  })

  it('DE-DUPS the C.5 dual-write: an already-messaged report is not re-quoted at terminal (INT.2)', async () => {
    const runId = seedDelegatedRun('implement the dual-written feature')
    // The chief run's activation row — with it, the mgmt `report` tool dual-writes
    // the report to K's mailbox at FILE time (C.5: reporter resolved via agent_runs).
    agentRunsDb.insertAgentRun.run({
      id: uuid(), profileId: 'chief', runId, trigger: 'delegation',
      goal: 'int2 dedup', projectId: null, workflowId: null,
      status: 'running', createdAt: Date.now(), completedAt: null,
    })
    fileChiefReport(runId, 'PR #77 opened; CI green')

    // The dual-write landed the raw report as a mailbox message immediately.
    const atFileTime = queuedMessages()
    expect(atFileTime).toHaveLength(1)
    expect(String(atFileTime[0].body)).toBe('PR #77 opened; CI green')
    expect(atFileTime[0].from_profile_id).toBe('chief')
    expect(atFileTime[0].provenance_run_id).toBe(runId)

    update(runId, 'done')

    // The terminal report-back queues the OUTCOME — never a second copy of the
    // report body (the operator would read identical content twice otherwise).
    const msgs = queuedMessages()
    expect(msgs).toHaveLength(2)
    const terminal = msgs.find(m => m.id !== atFileTime[0].id)!
    expect(String(terminal.body)).toContain('completed')
    expect(String(terminal.body)).not.toContain('PR #77 opened')
  })

  it('caps an oversize mgmt-report body on the queued message (~2000 chars + ellipsis)', async () => {
    const runId = seedDelegatedRun('implement the giant feature')

    // A verbose Chief report (zod allows up to 20k) must not dump into the mailbox
    // uncapped — the report-back path shares the 2000-char REPORT_BACK_TEXT_CAP.
    fileChiefReport(runId, 'r'.repeat(2_500))
    update(runId, 'done')

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    const body = String(msgs[0].body)
    expect(body.endsWith('…')).toBe(true)
    // prefix + capped body + ellipsis — never the raw 2500-char body.
    const prefix = 'Chief (delegation completed) reported: '
    expect(body.length).toBe(prefix.length + 2_000 + 1)
    // And it landed as a message, not a thread turn.
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).some(t => t.text.includes('reported:'))).toBe(false)
  })

  it('caps the assistant-text fallback (bounded event scan + ~2000-char cap)', async () => {
    const runId = seedDelegatedRun('refactor the giant module')

    // No mgmt report; 60 assistant events × 100 chars — more events than the 50-event
    // scan window and far more text than the 2000-char cap.
    const ins = db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'assistant', ?, ?)`,
    )
    for (let i = 1; i <= 60; i++) ins.run(uuid(), runId, i, Date.now(), 'a'.repeat(100))
    update(runId, 'done')

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    const body = String(msgs[0].body)
    expect(body.startsWith('Chief (delegation completed):')).toBe(true)
    expect(body.endsWith('…')).toBe(true)
    const prefix = 'Chief (delegation completed): '
    expect(body.length).toBe(prefix.length + 2_000 + 1)
  })

  it('falls back to a bare status line when no report was filed', async () => {
    const runId = seedDelegatedRun('refactor the module')

    update(runId, 'error')

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    expect(String(msgs[0].body)).toContain('no report was filed')
    expect(String(msgs[0].body)).toContain('error')
    expect(msgs[0].provenance_run_id).toBe(runId)
  })

  it('SWALLOWS a queueMessage throw in the finalize (deleted thread) — warn, no crash, no message', async () => {
    const runId = seedDelegatedRun('implement the doomed feature')

    // Delete the delegating thread row BEFORE the terminal fires. FK enforcement is
    // toggled off for the delete so the run's turns survive: under the cascade the
    // undo gate (kReplySuppressed) would swallow first and queueMessage would never
    // run — the failure under test is queueMessage's own unknown-thread throw.
    db.pragma('foreign_keys = OFF')
    try {
      db.prepare('DELETE FROM k_threads WHERE id = ?').run(DEFAULT_K_THREAD_ID)
    } finally {
      // finally so a throwing DELETE (e.g. SQLITE_BUSY) can never leave FK
      // enforcement off for the rest of the singleFork worker's test files.
      db.pragma('foreign_keys = ON')
    }
    fileChiefReport(runId, 'report into the void')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A lifecycle subscriber must never crash the event bus: the finalize swallows
      // the AgentMailError with a warn instead of letting it propagate.
      expect(() =>
        eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run),
      ).not.toThrow()
      expect(
        warn.mock.calls.map(c => String(c[0])).some(m => m.includes('failed to queue')),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
    expect(queuedMessages()).toHaveLength(0)
  })
})

// ── askK — undo (F-060) on the session engine (A.4) ───────────────────────────

describe('undoK — the undone ask is scrubbed from thread AND session (A.4)', () => {
  it('LIVE case: kill + turns deleted + session stale with cli_session_id NULL; a LATER terminal cannot resurrect it', async () => {
    const first = await askK('remind me to cancel the order')
    update(first.runId!, 'running', { cliSessionId: 'cli-live-undo' })
    update(first.runId!, 'awaiting_input')
    expect(kSessionRow()!.state).toBe('live')
    expect(sessionCliId()).toBe('cli-live-undo')

    undoK(first.runId!)

    // kill fired; every turn linked to the run is gone; the session is scrubbed.
    expect(vi.mocked(kill)).toHaveBeenCalledWith(first.runId)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
    expect(kSessionRow()!.state).toBe('stale')
    expect(sessionCliId()).toBeNull()
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBeNull()

    // The dying run's LATE terminal must not resurrect 'resumable' (taint holds).
    update(first.runId!, 'done')
    expect(kSessionRow()!.state).toBe('stale')
    expect(sessionCliId()).toBeNull()

    // The next ask re-establishes FRESH from the cleaned durable thread.
    await askK('what is the weather')
    expect(lastPersistentSession()!.resume).toBe(false)
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).not.toContain('cancel the order')
  })

  it('KILL WINDOW: a follow-up ask right after undoK cold-spawns FRESH — never stdin into the dying run (quality-M1 lock)', async () => {
    const first = await askK('remind me to cancel the order')
    update(first.runId!, 'awaiting_input') // park → live attachment
    expect(kSessionRow()!.state).toBe('live')

    undoK(first.runId!)
    // The dying run's terminal has NOT landed yet (kill is SIGTERM → 3s SIGKILL,
    // async) — the operator retypes immediately: the canonical undo-then-retype
    // flow. undoSessionRun tore the attachment down, so this must cold-spawn.
    const second = await askK('remind me to cancel the invoice instead')

    expect(second.warm).toBe(false)
    expect(second.runId).not.toBe(first.runId)
    expect(vi.mocked(startRun)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendInput)).not.toHaveBeenCalled()

    // The retyped turn is linked to the NEW run — the dead run's id can never
    // reach it (a re-undo of the OLD run deletes nothing of the new ask).
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].runId).toBe(second.runId)
    undoK(first.runId!)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')).toHaveLength(1)
  })

  it('LATE PARK: an awaiting_input flushed by the dying run after undoK cannot re-mark the scrubbed session live (quality-M1 lock)', async () => {
    const first = await askK('remind me to cancel the order')
    update(first.runId!, 'awaiting_input')
    expect(kSessionRow()!.state).toBe('live')

    undoK(first.runId!)
    expect(kSessionRow()!.state).toBe('stale')

    // The dying CLI flushes one more park before SIGKILL lands — the attachment
    // (and its subscription) is already torn down, so the row must stay scrubbed
    // (a stranded phantom 'live' would over-count the cap and mislead the LRU).
    update(first.runId!, 'awaiting_input')
    expect(kSessionRow()!.state).toBe('stale')
    expect(sessionCliId()).toBeNull()
  })

  it('AFTER TERMINAL: resolves the session via runs.session_id (A.3 stamp) and still scrubs the tainted CLI session', async () => {
    // Establish a session (first ask reaches 'done' → the row persists the id).
    const first = await askK('what is on my calendar')
    update(first.runId!, 'done')
    const sid = sessionCliId()
    expect(sid).toBeTruthy()

    // A RESUME ask answers-and-exits INSIDE the 5s undo window — by undo time the
    // attachment is detached and runToSession no longer knows the run.
    const resume = await askK('add a dentist appointment on Tuesday')
    expect(lastPersistentSession()).toMatchObject({ sessionId: sid, resume: true })
    eventBus.emitEvent({ id: uuid(), runId: resume.runId!, seq: 1, type: 'assistant', ts: Date.now(), text: 'Added the dentist appointment.' })
    update(resume.runId!, 'done')
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBeNull()
    expect(kSessionRow()!.state).toBe('resumable')
    expect(sessionCliId()).toBe(sid)

    undoK(resume.runId!)

    // The runs.session_id fallback found the session: scrubbed stale + id NULL,
    // and both undone turns are gone.
    expect(sessionCliId()).toBeNull()
    expect(kSessionRow()!.state).toBe('stale')
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.runId === resume.runId)).toHaveLength(0)

    // Next ask re-seeds fresh (resume=false, a NEW session, seed WITHOUT the undone message).
    await askK('what else is on my calendar')
    const ps = lastPersistentSession()!
    expect(ps.resume).toBe(false)
    expect(ps.sessionId).not.toBe(sid)
    const prompt = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(prompt).toContain('You:')
    expect(prompt).not.toContain('dentist appointment')
  })

  it('is idempotent — a second undo of the same run is a no-op', async () => {
    const runId = (await askK('note idempotent')).runId!
    undoK(runId)
    expect(() => undoK(runId)).not.toThrow()
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')).toHaveLength(0)
  })

  it('RACE: a LATE assistant/terminal flush after undoK does NOT resurrect an orphaned k reply', async () => {
    // The kill is fire-and-forget, so a still-streaming run can flush events AFTER undo.
    const runId = (await askK('remind me to cancel the order')).runId!
    undoK(runId)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)

    // The dying process flushes a late assistant event, then its terminal — captureAnswers'
    // subscriber is still LIVE (undo does not tear it down). Without the undo gate this
    // appended an orphaned 'k' reply for a run whose 'user' ask is already gone.
    eventBus.emitEvent({ id: uuid(), runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'late partial reply' })
    update(runId, 'killed')

    // No orphaned reply — the thread has NO turns for the undone run (nothing to reseed).
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.runId === runId)).toHaveLength(0)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
  })

  it('RACE: a delegated-run terminal after undoK does NOT resurrect an orphaned report-back', async () => {
    // The SAME "no unsubscribe on kill" gap in reportDelegationBack's finalize path —
    // wired DIRECTLY now (askK no longer delegates; Lane B.4 owns the callers).
    ensureDefaultKThread()
    const runId = `mock-k-run-del-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'chief', '.', 'running', ?)`,
    ).run(runId, Date.now())
    appendTurn(DEFAULT_K_THREAD_ID, 'user', 'fix the failing test suite', runId)
    reportDelegationBack(DEFAULT_K_THREAD_ID, runId)

    undoK(runId)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)

    // The delegated run files a report then terminates AFTER the undo — its subscriber
    // is still live. Without the gate this queued an orphaned report-back message
    // (B.4: the terminal must queue NOTHING once undoK removed the ask).
    fileChiefReport(runId, 'PR opened after undo')
    update(runId, 'done')

    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
    expect(queuedMessages()).toHaveLength(0)
  })
})

// ── Chief→K continuation — the lead outcome completes the up-chain (loop-b2) ───

/** Insert a real runs row + one assistant summary event (an FK-valid lead run). */
function seedLeadRun(id: string, summary: string, status = 'running'): void {
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'lead', '.', ?, ?)`,
  ).run(id, status, Date.now())
  db.prepare(
    `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'assistant', ?, ?)`,
  ).run(uuid(), id, Date.now(), summary)
}

const done = (id: string, status: Run['status'] = 'done'): Run =>
  ({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 }) as Run

describe('continueLeadOutcomeToK — the lead outcome completes the up-chain to K', () => {
  /** Seed the lead run's agent_runs activation row so the finalize can resolve the
   *  REPORTING profile (B.4: the message is FROM the lead that ran the work). */
  function seedLeadActivation(leadRunId: string, profileId: string): void {
    agentRunsDb.insertAgentRun.run({
      id: uuid(),
      profileId,
      runId: leadRunId,
      trigger: 'delegation',
      goal: 'b4 lead activation',
      projectId: null,
      workflowId: null,
      status: 'running',
      createdAt: Date.now(),
      completedAt: null,
    })
  }

  it('QUEUES the lead outcome as a message FROM the lead profile on the LEAD terminal (once)', async () => {
    // A run-linked ask turn is the derivable K→delegation edge (askK's session
    // spawn patches the run id onto the ask turn — A.4; no Chief dispatch needed).
    const chiefRunId = (await askK('implement the payment flow')).runId!
    expect(resolveKDelegationThread(chiefRunId)).toBe(DEFAULT_K_THREAD_ID)

    // The lead the Chief dispatched finishes AFTER the Chief's own turn could have ended.
    const leadRunId = `mock-k-run-lead-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Opened PR #7; CI green.')
    seedLeadActivation(leadRunId, 'ca-b-lead-prof')

    const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
    continueLeadOutcomeToK(chiefRunId, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    // ONE queued message from the LEAD's own profile (resolved via its activation row).
    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to_profile_id).toBe('k-secretary')
    expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)
    expect(msgs[0].from_kind).toBe('profile')
    expect(msgs[0].from_profile_id).toBe('ca-b-lead-prof')
    expect(msgs[0].provenance_run_id).toBe(leadRunId)
    expect(String(msgs[0].body)).toContain('Chief (via lead-backend)')
    expect(String(msgs[0].body)).toContain('completed')
    expect(String(msgs[0].body)).toContain('Opened PR #7')

    // NO 'k' turn was appended directly — the relay's wake path lands the durable turn.
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)

    // Fires ONCE: a duplicate terminal doesn't double-queue (run-lifecycle latch).
    eventBus.emitRunUpdate(done(leadRunId))
    expect(queuedMessages()).toHaveLength(1)
  })

  it('falls back to from=chief (the reporting chain\'s owner) when the lead run has NO activation row', async () => {
    const chiefRunId = (await askK('implement the checkout flow')).runId!

    const leadRunId = `mock-k-run-lead3-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Shipped the checkout flow.')
    // Deliberately NO agent_runs row for this lead run.

    continueLeadOutcomeToK(chiefRunId, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].from_profile_id).toBe('chief')
    expect(msgs[0].provenance_run_id).toBe(leadRunId)
    expect(String(msgs[0].body)).toContain('Shipped the checkout flow.')
  })

  it('is a no-op when the Chief woke AUTONOMOUSLY (no K delegation linked)', () => {
    ensureDefaultKThread()
    // A Chief run with NO linked k_thread_turn (an autonomous wake) → no thread resolves.
    const autoChiefRun = `mock-k-run-auto-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'chief', '.', 'done', ?)`,
    ).run(autoChiefRun, Date.now())
    expect(resolveKDelegationThread(autoChiefRun)).toBeNull()

    const leadRunId = `mock-k-run-lead2-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Lead ran on an autonomous Chief wake.')

    continueLeadOutcomeToK(autoChiefRun, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    // NOTHING queued (and no turn) — the outcome stays in the Chief's mgmt store only.
    expect(queuedMessages()).toHaveLength(0)
    expect(
      listKThreadTurns(DEFAULT_K_THREAD_ID).some(t =>
        t.text.includes('Lead ran on an autonomous Chief wake'),
      ),
    ).toBe(false)
  })

  it('summarizeChiefLeadContinuation prefers assistant text, else a bare status line', () => {
    const runId = `mock-k-run-sum-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'lead', '.', 'done', ?)`,
    ).run(runId, Date.now())
    // No assistant events yet → the bare fallback line.
    expect(summarizeChiefLeadContinuation(runId, 'lead-frontend', 'done')).toContain(
      'no summary was produced',
    )
    db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'assistant', ?, ?)`,
    ).run(uuid(), runId, Date.now(), 'Shipped the component.')
    const s = summarizeChiefLeadContinuation(runId, 'lead-frontend', 'error')
    expect(s).toContain('Chief (via lead-frontend) error') // non-'done' status surfaces verbatim
    expect(s).toContain('Shipped the component.')
  })
})

// ── pipeline→K continuation — a delegated pipeline's terminal queues a message (B.4) ──

describe('continuePipelineOutcomeToK — a delegated pipeline terminal queues a message', () => {
  /** Seed a pipeline run with ONE passed stage (so maybeFinalizePipeline completes it),
   *  optionally linked to a delegating K run via a pipeline_dispatches intent row. */
  function seedTerminalPipeline(
    opts: { owner?: string | null; kRunId?: string | null; title?: string; definitionId?: string },
  ): string {
    const pid = `mock-k-pipe-${uuid().slice(0, 8)}`
    const now = Date.now()
    pipelineDb.insertPipelineRun.run({
      id: pid,
      // Lane E: overridable so a test can point at DOMAIN_DEF_ID (domain_id stamped,
      // manager = DOMAIN_MGR_PROFILE_ID) instead of the domain-less default 'ca-b4-def'.
      // The dispatch row's own pipeline_id stays 'ca-b4-def' below regardless (a
      // separate concern from pipeline_runs.definition_id) — resetKState's targeted
      // cleanup keys off THAT literal, unaffected by this override.
      definitionId: opts.definitionId ?? 'ca-b4-def',
      projectId: null,
      title: opts.title ?? 'B4 pipeline',
      cwd: '.',
      baseCommit: 'deadbeef',
      createdAt: now,
      updatedAt: now,
      ownerProfileId: opts.owner ?? null,
      // C.1 (D-125): insertPipelineRun's named-param set gained domainId — the
      // attribution column the domain supervisor groups by. NULL: no domain here.
      domainId: null,
    })
    const stageId = uuid()
    pipelineDb.insertStage.run({
      id: stageId,
      pipelineRunId: pid,
      stageKey: 's1',
      kind: 'agent',
      profileId: null,
      spec: '{}',
      baseCommit: null,
      repairStageKey: null,
      createdAt: now,
      updatedAt: now,
    })
    pipelineDb.markStagePassed.run({
      id: stageId, resultCommit: null, exitCode: 0, costUsd: null, updatedAt: now, completedAt: now,
    })
    if (opts.kRunId != null) {
      const did = `mock-k-pd-${uuid().slice(0, 8)}`
      pipelineDb.insertPipelineDispatch.run({
        id: did, pipelineId: 'ca-b4-def', kRunId: opts.kRunId, goal: 'b4', projectId: null, model: null, createdAt: now,
      })
      pipelineDb.claimPipelineDispatch.run({ id: did, dispatchedAt: now })
      pipelineDb.setPipelineDispatchRun.run({ id: did, pipelineRunId: pid })
    }
    return pid
  }

  /** A bare delegating K run: a runs row + a linking user turn, NO agent_runs row. */
  function seedBareDelegatingKRun(): string {
    ensureDefaultKThread()
    const kRunId = `mock-k-run-bare-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'done', ?)`,
    ).run(kRunId, Date.now())
    db.prepare(
      `INSERT INTO k_thread_turns (id, thread_id, role, text, run_id, created_at) VALUES (?, ?, 'user', 'delegate a pipeline', ?, ?)`,
    ).run(uuid(), DEFAULT_K_THREAD_ID, kRunId, Date.now())
    return kRunId
  }

  it('a real orchestrator OWNER gets the update in ITS OWN conversation, never k-secretary\'s (D-131 fix)', async () => {
    // A real K→Chief delegation links the delegating run to the K thread.
    const { runId: kRunId } = await askK('fix the failing pipeline suite')
    const stop = continuePipelineOutcomeToK()
    try {
      const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
      const pid = seedTerminalPipeline({ owner: 'ca-b-lead-prof', kRunId })
      maybeFinalizePipeline(pid)

      const ownerConvId = getOrCreateConversation('ca-b-lead-prof').id

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      // Delivered to the OWNER's own conversation — self-addressed (from === to),
      // the same pattern domain-supervisor.ts::briefDomain uses — NOT k-secretary's.
      expect(msgs[0].to_profile_id).toBe('ca-b-lead-prof')
      expect(msgs[0].to_thread_id).toBe(ownerConvId)
      expect(msgs[0].to_thread_id).not.toBe(DEFAULT_K_THREAD_ID)
      expect(msgs[0].from_kind).toBe('profile')
      expect(msgs[0].from_profile_id).toBe('ca-b-lead-prof') // pipeline_runs.owner_profile_id
      expect(msgs[0].provenance_run_id).toBeNull() // no single run owns a multi-run pipeline
      expect(String(msgs[0].body)).toBe('Pipeline "B4 pipeline" completed.')

      // K's OWN thread received NOTHING — the "random orchestrator in K's chat" bug
      // this fix closes. No 'k' turn was appended directly either.
      expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)
    } finally {
      stop()
    }
  })

  it('generic default-orchestrator owner WITH a domain manager → lands in the MANAGER\'s own conversation, never the generic\'s (Lane E fix)', async () => {
    const { runId: kRunId } = await askK('run the domain pipeline')
    const stop = continuePipelineOutcomeToK()
    try {
      const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
      const pid = seedTerminalPipeline({ owner: ORG_DEFAULT_PROFILE_ID, kRunId, definitionId: DOMAIN_DEF_ID })
      maybeFinalizePipeline(pid)

      const managerConvId = getOrCreateConversation(DOMAIN_MGR_PROFILE_ID).id
      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_kind).toBe('profile')
      expect(msgs[0].from_profile_id).toBe(DOMAIN_MGR_PROFILE_ID)
      expect(msgs[0].to_profile_id).toBe(DOMAIN_MGR_PROFILE_ID)
      expect(msgs[0].to_thread_id).toBe(managerConvId)
      expect(String(msgs[0].body)).toBe('Pipeline "B4 pipeline" completed.')

      // Never authored by, or into, the generic default-orchestrator.
      expect(msgs.some(m => m.from_profile_id === ORG_DEFAULT_PROFILE_ID)).toBe(false)
      expect(msgs.some(m => m.to_profile_id === ORG_DEFAULT_PROFILE_ID)).toBe(false)
      const genericThread = db.prepare(`SELECT 1 FROM k_threads WHERE profile_id = ?`).get(ORG_DEFAULT_PROFILE_ID)
      expect(genericThread).toBeUndefined()

      // K's OWN thread received NOTHING either.
      expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)
    } finally {
      stop()
    }
  })

  it('generic default-orchestrator owner with NO domain manager → falls back to k-secretary\'s delegating thread, never creating the generic\'s own conversation (Lane E fix)', () => {
    const kRunId = seedBareDelegatingKRun()
    const stop = continuePipelineOutcomeToK()
    try {
      // definitionId omitted → the domain-less default 'ca-b4-def' (no workflow_definitions
      // row exists for it in this file, so domainForPipelineDef resolves null → no manager).
      const pid = seedTerminalPipeline({ owner: ORG_DEFAULT_PROFILE_ID, kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_profile_id).toBe('k-secretary')
      expect(msgs[0].to_profile_id).toBe('k-secretary')
      expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)

      // The generic default-orchestrator's own conversation was never created, and it
      // never appears as either endpoint of the delivered message.
      const genericThread = db.prepare(`SELECT 1 FROM k_threads WHERE profile_id = ?`).get(ORG_DEFAULT_PROFILE_ID)
      expect(genericThread).toBeUndefined()
      expect(msgs.some(m => m.from_profile_id === ORG_DEFAULT_PROFILE_ID)).toBe(false)
      expect(msgs.some(m => m.to_profile_id === ORG_DEFAULT_PROFILE_ID)).toBe(false)
    } finally {
      stop()
    }
  })

  it('owner NULL → falls back to the delegating K run\'s profile, delivered to THAT profile\'s conversation', async () => {
    // The delegating run carries its own agent_runs activation (seeded as 'chief'
    // here — A.4 retired askK's auto-delegation, so the edge is seeded directly;
    // the fallback under test reads the delegating run's OWN activation profile).
    const kRunId = seedBareDelegatingKRun()
    agentRunsDb.insertAgentRun.run({
      id: uuid(),
      profileId: 'chief',
      runId: kRunId,
      trigger: 'delegation',
      goal: 'b4 delegating activation',
      projectId: null,
      workflowId: null,
      status: 'completed',
      createdAt: Date.now(),
      completedAt: Date.now(),
    })
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: null, kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_profile_id).toBe('chief')
      expect(msgs[0].to_profile_id).toBe('chief')
      expect(msgs[0].to_thread_id).toBe(getOrCreateConversation('chief').id)
      expect(msgs[0].provenance_run_id).toBeNull()
    } finally {
      stop()
    }
  })

  it('owner NULL + no activation row on the delegating run → falls back to k-secretary\'s OWN delegating thread', () => {
    const kRunId = seedBareDelegatingKRun()
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: null, kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_profile_id).toBe('k-secretary')
      // Preserved behavior: k-secretary keeps landing on the ORIGINAL delegating
      // thread (not necessarily the default thread — resolveKDelegationThread's
      // own resolution), not re-routed through getOrCreateConversation.
      expect(msgs[0].to_profile_id).toBe('k-secretary')
      expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)
    } finally {
      stop()
    }
  })

  it('owner points to a since-deleted profile → falls back to k-secretary delivery, never silently dropped', () => {
    // owner_profile_id has no FK, so a run can outlive its owner profile. Without the
    // guard, queueMessage(toProfileId=<deleted>) throws and the outcome vanishes;
    // the guard reroutes it to k-secretary's own delegating thread so it's never lost.
    const kRunId = seedBareDelegatingKRun()
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: 'deleted-orch-does-not-exist', kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1) // delivered, not dropped
      expect(msgs[0].from_profile_id).toBe('k-secretary')
      expect(msgs[0].to_profile_id).toBe('k-secretary')
      expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)
    } finally {
      stop()
    }
  })

  it('a NON-delegated pipeline terminal queues NOTHING', () => {
    ensureDefaultKThread()
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: 'ca-b-lead-prof', kRunId: null })
      maybeFinalizePipeline(pid)
      expect(queuedMessages()).toHaveLength(0)
      expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
    } finally {
      stop()
    }
  })
})
