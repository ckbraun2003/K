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
import { db, agentRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, sendInput, kill, __testHooks } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { mgmtTools } from '../src/mcp/mgmt.js'

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

function resetKState() {
  db.prepare('DELETE FROM agent_sessions').run()
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  db.prepare(`DELETE FROM agent_runs WHERE profile_id IN ('k-secretary', 'chief')`).run()
  // A.4: forced routes queue mailbox rows — clear the user-originated ones this
  // file created (the blanket-delete convention the thread tables already use).
  db.prepare(`DELETE FROM agent_messages WHERE from_kind = 'user'`).run()
  // mgmt reports the report-back tests file against mock runs — clear them before
  // the runs (run_id → runs(id) ON DELETE SET NULL, but tidy anyway).
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id LIKE 'mock-k-%'`).run()
  // events.run_id is NOT NULL REFERENCES runs(id) (no ON DELETE) — clear the mock
  // runs' events before deleting the runs, or the delete hits a FK constraint.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-k-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-k-%'`).run()
}

// Guard-create the 'k-secretary' profile askK's session engine activates — do NOT
// call seedProfiles(): the durable roster is a global invariant profiles.test.ts
// asserts on a clean DB. (No 'chief' profile needed since A.4 — askK never
// dispatches the Chief; forced routes queue mailbox rows, no dispatch at all.)
let createdKSecretary = false

beforeAll(() => {
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
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

// ── reportDelegationBack — the report-back seam (Lane B rewires the caller) ───

describe('reportDelegationBack — delegated-outcome report-back (kept for Lane B)', () => {
  /** Seed an FK-valid delegated run + its run-linked ask turn, and wire the seam
   *  directly (askK no longer delegates — Lane B.4 reroutes the callers). */
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

  it("folds the delegated run's mgmt report onto K's thread at its terminal", async () => {
    const runId = seedDelegatedRun('implement the new feature')

    fileChiefReport(runId, 'PR #42 opened; CI green')
    update(runId, 'done')

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    const reportBack = kTurns.find(t => t.text.includes('PR #42 opened'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text).toContain('completed')
    expect(reportBack!.runId).toBe(runId)
  })

  it('caps an oversize mgmt-report body on the report-back turn (~2000 chars + ellipsis)', async () => {
    const runId = seedDelegatedRun('implement the giant feature')

    fileChiefReport(runId, 'r'.repeat(2_500))
    update(runId, 'done')

    const reportBack = listKThreadTurns(DEFAULT_K_THREAD_ID)
      .filter(t => t.role === 'k')
      .find(t => t.text.includes('reported:'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text.endsWith('…')).toBe(true)
    const prefix = 'Chief (delegation completed) reported: '
    expect(reportBack!.text.length).toBe(prefix.length + 2_000 + 1)
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

    const reportBack = listKThreadTurns(DEFAULT_K_THREAD_ID)
      .filter(t => t.role === 'k')
      .find(t => t.text.includes('Chief (delegation completed):'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text.endsWith('…')).toBe(true)
    const prefix = 'Chief (delegation completed): '
    expect(reportBack!.text.length).toBe(prefix.length + 2_000 + 1)
  })

  it('falls back to a bare status line when no report was filed', async () => {
    const runId = seedDelegatedRun('refactor the module')

    update(runId, 'error')

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    const reportBack = kTurns.find(t => t.text.includes('no report was filed'))
    expect(reportBack).toBeTruthy()
    expect(reportBack!.text).toContain('error')
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
    // is still live. Without the gate this appended an orphaned report-back turn.
    fileChiefReport(runId, 'PR opened after undo')
    update(runId, 'done')

    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
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
  it('appends the lead outcome onto the delegating K thread on the LEAD terminal (once)', async () => {
    // A run-linked ask turn is the derivable K→delegation edge (askK's session
    // spawn patches the run id onto the ask turn).
    const chiefRunId = (await askK('implement the payment flow')).runId!
    expect(resolveKDelegationThread(chiefRunId)).toBe(DEFAULT_K_THREAD_ID)

    // The lead the Chief dispatched finishes AFTER the Chief's own turn could have ended.
    const leadRunId = `mock-k-run-lead-${uuid().slice(0, 8)}`
    seedLeadRun(leadRunId, 'Opened PR #7; CI green.')

    continueLeadOutcomeToK(chiefRunId, leadRunId, 'lead-backend')
    eventBus.emitRunUpdate(done(leadRunId))

    const cont = listKThreadTurns(DEFAULT_K_THREAD_ID)
      .filter(t => t.role === 'k')
      .find(t => t.text.includes('Opened PR #7'))
    expect(cont).toBeTruthy()
    expect(cont!.text).toContain('Chief (via lead-backend)')
    expect(cont!.text).toContain('completed')
    expect(cont!.runId).toBe(leadRunId) // linked to the lead run — part of the traceable chain

    // Fires ONCE: a duplicate terminal doesn't double-append (run-lifecycle latch).
    eventBus.emitRunUpdate(done(leadRunId))
    expect(
      listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.text.includes('Opened PR #7')),
    ).toHaveLength(1)
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

    // No continuation turn landed — the outcome stays in the Chief's mgmt store only.
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
