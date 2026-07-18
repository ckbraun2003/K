/**
 * k-thread.ts — the K front-door runtime (P5.1c, D-023).
 *
 * Same supervisor-mock pattern as agent-runs.test.ts: startRun is mocked so no real
 * process spawns, but it INSERTS a real runs row (k_threads.active_run_id,
 * k_thread_turns.run_id and agent_runs.run_id all FK → runs(id)). The mock captures
 * its call args so a test can assert the W7a persistentSession opt (gating). `kill` is
 * mocked (undoK best-effort). Isolated DB via vitest.config.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { db, agentRunsDb, pipelineDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun, __testHooks } from '../src/supervisor.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { mgmtTools } from '../src/mcp/mgmt.js'
import { maybeFinalizePipeline } from '../src/pipeline-engine.js'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real runs
// row (the K thread + agent_runs rows FK → runs(id)). sendInput / __testHooks stay
// REAL (spread ...actual) so the warm path uses the true machinery.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-k-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const {
  askK,
  undoK,
  ensureDefaultKThread,
  getKThread,
  listKThreadTurns,
  renderSeed,
  DEFAULT_K_THREAD_ID,
  continueLeadOutcomeToK,
  continuePipelineOutcomeToK,
  resolveKDelegationThread,
  summarizeChiefLeadContinuation,
} = await import('../src/k-thread.js')

/** Read the thread's persisted CLI session id (NULL until the first ask succeeds). */
function threadSessionId(threadId = DEFAULT_K_THREAD_ID): string | null {
  return (db.prepare('SELECT cli_session_id FROM k_threads WHERE id = ?').get(threadId) as
    { cli_session_id: string | null } | undefined)?.cli_session_id ?? null
}

/** The persistentSession opt startRun was last called with (W7a gating). */
function lastPersistentSession(): { key: string; sessionId: string; resume: boolean } | undefined {
  const call = vi.mocked(startRun).mock.calls.at(-1)!
  return (call[1] as { persistentSession?: { key: string; sessionId: string; resume: boolean } }).persistentSession
}

/** All queued/delivered agent_messages rows, oldest-first (B.4: report-backs are messages). */
function queuedMessages(): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM agent_messages ORDER BY created_at ASC, id ASC`).all() as Array<
    Record<string, unknown>
  >
}

function resetKState() {
  db.prepare('DELETE FROM k_thread_turns').run()
  db.prepare('DELETE FROM k_threads').run()
  // B.4: report-backs now land in the mailbox — clear it like the thread tables above
  // (this file already blanket-cleans its k_* tables; agent_messages joins that set).
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

// Guard-create the 'k-secretary' (logistics/fresh path) + 'chief' (delegation path)
// profiles askK activates — do NOT call seedProfiles(): the durable roster is a global
// invariant profiles.test.ts asserts on a clean DB, so seeding all eight here would
// pollute that. Clean up only what we created (serial run — no cross-file race).
let createdKSecretary = false
let createdChief = false
let createdLeadProf = false

beforeAll(() => {
  if (!getProfile('k-secretary')) {
    createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' })
    createdKSecretary = true
  }
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
})

beforeEach(() => {
  resetKState()
})

afterAll(() => {
  resetKState()
  if (createdKSecretary) db.prepare(`DELETE FROM agent_profiles WHERE id = 'k-secretary'`).run()
  if (createdChief) db.prepare(`DELETE FROM agent_profiles WHERE id = 'chief'`).run()
  if (createdLeadProf) db.prepare(`DELETE FROM agent_profiles WHERE id = 'ca-b-lead-prof'`).run()
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
    // The trailing K_SEED_INSTRUCTION rides on every cold reseed. It must steer K to
    // pick the right store by intent instead of defaulting everything to a work item:
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

// ── askK — fresh (cold) dispatch ──────────────────────────────────────────────

describe('askK — resumable one-shot dispatch + answer capture (W7a)', () => {
  it('starts a resumable ONE-SHOT run, records the ask, captures K answers + persists the session id, clears on terminal', async () => {
    // A LOGISTICS message (no engineering signal) so K handles it itself — an
    // engineering ask now delegates to the Chief (see the delegation suite).
    const result = await askK('remind me to prep the meeting notes')

    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(result.kThreadId).toBe(DEFAULT_K_THREAD_ID)
    expect(typeof result.agentRunId).toBe('string')

    // FIRST ask: a per-thread persistentSession, resume=false (establish the session),
    // a NON-interactive one-shot (no interactive flag), seeded with the full renderSeed
    // transcript (a "You:" line) — NOT a bare message.
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    expect(String(call[0])).toContain('You: remind me to prep the meeting notes')
    expect((call[1] as { interactive?: boolean }).interactive).toBeFalsy()
    const ps = lastPersistentSession()!
    expect(ps).toMatchObject({ key: DEFAULT_K_THREAD_ID, resume: false })
    expect(ps.sessionId).toMatch(/[0-9a-f-]{36}/)

    // A 'user' turn is recorded on the default thread, linked to the run.
    const userTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].text).toBe('remind me to prep the meeting notes')
    expect(userTurns[0].runId).toBe(result.runId)

    // The thread points at the in-flight run until it terminates.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBe(result.runId)

    // Two assistant events land, then the one-shot's terminal 'done' (no awaiting_input
    // park) — captureAnswers folds them into one 'k' turn AND persists the session id.
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'Hello' })
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 2, type: 'assistant', ts: Date.now(), text: 'from K' })
    eventBus.emitRunUpdate({ id: result.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('Hello\nfrom K')
    expect(kTurns[0].runId).toBe(result.runId)

    // The thread is cleared (idle) and now carries the persisted CLI session id.
    const thread = getKThread(DEFAULT_K_THREAD_ID)!
    expect(thread.activeRunId).toBeNull()
    expect(thread.status).toBe('idle')
    expect(threadSessionId()).toBe(ps.sessionId)

    // The non-escalating path activated the 'k-secretary' profile — NOT the Chief.
    const kRows = agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 10) as Array<Record<string, unknown>>
    expect(kRows).toHaveLength(1)
    expect(kRows[0].trigger).toBe('user-message')
    expect(kRows[0].run_id).toBe(result.runId)
  })

  it('does NOT persist the session id when the first ask fails (non-done terminal) — next ask starts fresh', async () => {
    const result = await askK('note the errands')
    // The run errors (killed/crashed) BEFORE answering → captureAnswers must not stamp
    // a session id that --resume would then miss.
    eventBus.emitRunUpdate({ id: result.runId, status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    expect(threadSessionId()).toBeNull()

    // So the NEXT ask is treated as a fresh first ask (resume=false) again.
    await askK('note the errands again')
    expect(lastPersistentSession()!.resume).toBe(false)
  })

  it('captures ONLY the new assistant text at each boundary (seq-windowed, two boundaries)', async () => {
    const result = await askK('note the grocery list')

    // Boundary 1: two assistant events → one folded 'k' turn.
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'turn one a' })
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 2, type: 'assistant', ts: Date.now(), text: 'turn one b' })
    eventBus.emitRunUpdate({ id: result.runId, status: 'awaiting_input', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    let kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toBe('turn one a\nturn one b')

    // Boundary 2 (terminal): only the NEW assistant event (seq 3) is captured — the
    // seq window advanced past 1-2, so turn two must not re-include turn one's text.
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 3, type: 'assistant', ts: Date.now(), text: 'turn two only' })
    eventBus.emitRunUpdate({ id: result.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k')
    expect(kTurns).toHaveLength(2)
    // Content assertions, not positional: both turns can share a created_at ms and
    // listTurns tie-breaks on random uuid — order within the ms is not deterministic.
    // The pin still holds: a re-capture regression would fold turn one's text into
    // the second turn ('turn one a\nturn one b\nturn two only'), so the exact
    // 'turn two only' member would vanish.
    const texts = kTurns.map(t => t.text)
    expect(texts).toContain('turn one a\nturn one b')
    expect(texts).toContain('turn two only')
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
    eventBus.emitEvent({ id: uuid(), runId: result.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'Noted.' })
    eventBus.emitRunUpdate({ id: result.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    // The reply un-archived the thread: archived_at is cleared and it is back in the DEFAULT
    // (non-archived) list — so the operator actually sees K's answer instead of it landing hidden.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.archivedAt).toBeNull()
    const defaultList = db.prepare('SELECT id FROM k_threads WHERE archived_at IS NULL').all() as Array<{ id: string }>
    expect(defaultList.some(t => t.id === DEFAULT_K_THREAD_ID)).toBe(true)
  })
})

// ── askK — resumable session (one-shot, W7a) ──────────────────────────────────

describe('askK — resumable session (one-shot, W7a)', () => {
  /** Run a first ask to completion so the thread carries a persisted session id. */
  async function establishSession(msg = 'what is on my calendar'): Promise<string> {
    const first = await askK(msg)
    eventBus.emitRunUpdate({ id: first.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    const sid = threadSessionId()
    expect(sid).toBeTruthy()
    return sid!
  }

  it('a SECOND ask RESUMES the persisted session and sends ONLY the new message (no 12-turn transcript replay)', async () => {
    const sessionId = await establishSession()

    const second = await askK('add lunch with Sam at noon')
    expect(second.warm).toBe(false)
    expect(second.runId).not.toBe(undefined)

    // startRun got resume=true + the SAME session id; the prompt is ONLY the new message
    // — the renderSeed transcript (a "You:" replay of prior turns) is NOT re-sent.
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    expect(String(call[0])).toBe('add lunch with Sam at noon')
    expect(String(call[0])).not.toContain('You:')
    expect(String(call[0])).not.toContain('what is on my calendar')
    expect(lastPersistentSession()).toMatchObject({ key: DEFAULT_K_THREAD_ID, sessionId, resume: true })
  })

  it('a FIRST ask (no session yet) establishes the session with the full renderSeed transcript', async () => {
    const r = await askK('note the milk')
    expect(r.warm).toBe(false)
    expect(lastPersistentSession()!.resume).toBe(false)
    // Full seed (renderSeed) on a fresh session — the fallback replay path.
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).toContain('You: note the milk')
    // __testHooks stays imported/exercised elsewhere; keep the reference honest.
    expect(typeof __testHooks.initSeq).toBe('function')
  })
})

// ── askK — delegation to the Chief (D-046) ────────────────────────────────────

/** All chief agent_runs (newest first) on the shared DB. */
function chiefAgentRuns(): Array<Record<string, unknown>> {
  return agentRunsDb.listRecentAgentRunsByProfile.all('chief', 500) as Array<Record<string, unknown>>
}

/** File a mgmt report against `runId` exactly as the Chief's mgmt `report` tool does. */
function fileChiefReport(runId: string, body: string) {
  const report = mgmtTools.find(t => t.name === 'report')!
  return report.handler({ body }, { runId })
}

describe('askK — delegation to the Chief', () => {
  it('an engineering-routed ask dispatches the Chief with trigger=delegation (not a K run)', async () => {
    const result = await askK('fix the failing test suite')

    // The route escalated and the returned run is the Chief's delegated run.
    expect(result.route.target).toBe('chief')
    expect(result.warm).toBe(false)
    expect(result.runId).toMatch(/^mock-k-run-/)
    expect(typeof result.agentRunId).toBe('string')

    // A chief agent_run exists with trigger 'delegation', linked to that run, carrying
    // the ask verbatim in its goal.
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger).toBe('delegation')
    expect(rows[0].run_id).toBe(result.runId)
    expect(String(rows[0].goal)).toContain('fix the failing test suite')

    // No k-secretary activation was created on the delegation path.
    expect(agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 500)).toHaveLength(0)

    // The thread carries the durable link: the user turn is linked to the Chief run
    // (parent→child, derivable via k_thread_turns.run_id + agent_runs.trigger), and an
    // acknowledgment 'k' turn names the route.
    const turns = listKThreadTurns(DEFAULT_K_THREAD_ID)
    const userTurn = turns.find(t => t.role === 'user')!
    expect(userTurn.text).toBe('fix the failing test suite')
    expect(userTurn.runId).toBe(result.runId)
    const ackTurn = turns.find(t => t.role === 'k')!
    expect(ackTurn.text).toContain('Routing to')
    expect(ackTurn.runId).toBe(result.runId)

    // Delegation does NOT hijack the thread's warm-session pointer.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBeNull()
  })

  it('routes a named-lead ask through the Chief with the discipline hinted in the goal', async () => {
    const result = await askK('update the react component styling')
    expect(result.route.target).toBe('frontend')

    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger).toBe('delegation')
    expect(String(rows[0].goal)).toContain('frontend')
    expect(String(rows[0].goal)).toContain('update the react component styling')
  })

  it("QUEUES the Chief's report as an agent message on terminal — no direct k turn (B.4)", async () => {
    const result = await askK('implement the new feature')
    const runId = result.runId

    // The Chief files a status report up the chain (the mgmt `report` tool), then its
    // run reaches terminal — the report-back is now a MESSAGE from the Chief to K's
    // delegating thread (the relay delivers it; no bespoke appendTurn).
    fileChiefReport(runId, 'PR #42 opened; CI green')
    const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

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

    // NO new 'k' turn was appended by the report-back itself — only the pre-existing
    // "Routing to …" ack (an acknowledgment of the operator's own ask) remains.
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)
    const kTurns = listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'k' && t.runId === runId)
    expect(kTurns).toHaveLength(1)
    expect(kTurns[0].text).toContain('Routing to')

    // The delegated chief activation is finalized 'completed' by startAgentRun's own
    // lifecycle tracking on the same terminal event.
    const chiefRow = chiefAgentRuns()[0]
    expect(chiefRow.status).toBe('completed')
  })

  it('caps an oversize mgmt-report body on the queued message (~2000 chars + ellipsis)', async () => {
    const result = await askK('implement the giant feature')
    const runId = result.runId

    // A verbose Chief report (zod allows up to 20k) must not dump into the mailbox
    // uncapped — the report-back path shares the 2000-char REPORT_BACK_TEXT_CAP.
    fileChiefReport(runId, 'r'.repeat(2_500))
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

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
    const result = await askK('refactor the giant module')
    const runId = result.runId

    // No mgmt report; 60 assistant events × 100 chars — more events than the 50-event
    // scan window and far more text than the 2000-char cap.
    const ins = db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'assistant', ?, ?)`,
    )
    for (let i = 1; i <= 60; i++) ins.run(uuid(), runId, i, Date.now(), 'a'.repeat(100))
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    const body = String(msgs[0].body)
    expect(body.startsWith('Chief (delegation completed):')).toBe(true)
    expect(body.endsWith('…')).toBe(true)
    const prefix = 'Chief (delegation completed): '
    expect(body.length).toBe(prefix.length + 2_000 + 1)
  })

  it('falls back to a bare status line when the Chief filed no report', async () => {
    const result = await askK('refactor the module')
    const runId = result.runId

    // No mgmt report, no assistant events — terminal with an error status.
    eventBus.emitRunUpdate({ id: runId, status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const msgs = queuedMessages()
    expect(msgs).toHaveLength(1)
    expect(String(msgs[0].body)).toContain('no report was filed')
    expect(String(msgs[0].body)).toContain('error')
    expect(msgs[0].provenance_run_id).toBe(runId)
  })

  it('SWALLOWS a queueMessage throw in the finalize (deleted thread) — warn, no crash, no message', async () => {
    const result = await askK('implement the doomed feature')
    const runId = result.runId

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

  it('a dispatch throw propagates and leaves the chief activation failed, no ack turn', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))

    await expect(askK('deploy the build')).rejects.toThrow('boom')

    // startAgentRun inserted the row 'running' then rolled it back to 'failed' + rethrew.
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].run_id).toBeNull()

    // The durable user turn stays (thread is source of truth); no 'k' ack turn was added.
    const turns = listKThreadTurns(DEFAULT_K_THREAD_ID)
    expect(turns.filter(t => t.role === 'user')).toHaveLength(1)
    expect(turns.filter(t => t.role === 'k')).toHaveLength(0)
  })
})

// ── askK — power controls: forceRoute + model (C2) ────────────────────────────

describe('askK — forceRoute + model power controls', () => {
  it('forceRoute:chief delegates a message the classifier would keep as logistics', async () => {
    // routeForMessage classifies this as logistics (no engineering signal) — the
    // forced route must win and hand it to the Chief anyway.
    const { routeForMessage } = await import('@k/shared')
    expect(routeForMessage('remind me to water the plants').escalates).toBe(false)

    const result = await askK('remind me to water the plants', { forceRoute: 'chief' })

    expect(result.route.target).toBe('chief')
    expect(result.route.escalates).toBe(true)
    // The Chief was activated (trigger=delegation); no k-secretary run started.
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger).toBe('delegation')
    expect(agentRunsDb.listRecentAgentRunsByProfile.all('k-secretary', 500)).toHaveLength(0)
  })

  it('a forced named lead carries the discipline hint in the delegation goal', async () => {
    await askK('handle this one', { forceRoute: 'frontend' })
    const rows = chiefAgentRuns()
    expect(rows).toHaveLength(1)
    // buildDelegationGoal's named-lead hint path — the Chief can assign_lead on it.
    expect(String(rows[0].goal)).toContain('frontend')
    expect(String(rows[0].goal)).toContain('handle this one')
  })

  it('an explicit model on a FIRST logistics ask reaches startRun (one-shot, resume=false)', async () => {
    await askK('note the grocery list', { model: 'claude-opus-4-8' })
    const lastCall = vi.mocked(startRun).mock.calls.at(-1)!
    // One-shot resumable (NOT interactive), first ask establishes the session.
    expect(lastCall[1]).toMatchObject({ model: 'claude-opus-4-8', persistentSession: { resume: false } })
    expect((lastCall[1] as { interactive?: boolean }).interactive).toBeFalsy()
  })

  it('an explicit model on a RESUME ask still resumes the SAME session under that model (no continuity lost)', async () => {
    // First ask establishes + persists the session (design A: a model override no longer
    // forfeits continuity — there is no live process to keep).
    const first = await askK('note the follow-ups')
    eventBus.emitRunUpdate({ id: first.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    const sessionId = threadSessionId()!

    // A LOGISTICS follow-up (no engineering keyword) so K keeps handling it itself.
    const second = await askK('what else is on my calendar', { model: 'claude-opus-4-8' })
    expect(second.warm).toBe(false)
    expect(second.runId).not.toBe(first.runId)
    const lastCall = vi.mocked(startRun).mock.calls.at(-1)!
    expect(lastCall[1]).toMatchObject({ model: 'claude-opus-4-8', persistentSession: { sessionId, resume: true } })
  })
})

// ── askK — undo (F-060) + regular-dispatch gating ─────────────────────────────

describe('undoK — an undone ask is not replayed (F-060)', () => {
  it('removes the dangling user turn a killed ask left behind; a later reseed excludes it', async () => {
    const { runId } = await askK('remind me to cancel the order')
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')).toHaveLength(1)

    undoK(runId)

    // The dangling user turn is GONE (not merely the run killed) — nothing to replay.
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
    const thread = getKThread(DEFAULT_K_THREAD_ID)!
    expect(thread.activeRunId).toBeNull()
    expect(thread.status).toBe('idle')

    // An undone FIRST ask never persisted a session id → the next ask is fresh AND its
    // renderSeed seed does NOT contain the undone message.
    expect(threadSessionId()).toBeNull()
    await askK('what is the weather')
    expect(String(vi.mocked(startRun).mock.calls.at(-1)![0])).not.toContain('cancel the order')
    expect(lastPersistentSession()!.resume).toBe(false)
  })

  it('is idempotent — a second undo of the same run is a no-op', async () => {
    const { runId } = await askK('note idempotent')
    undoK(runId)
    expect(() => undoK(runId)).not.toThrow()
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')).toHaveLength(0)
  })

  it('IN-FLIGHT: nulls the tainted CLI session so a RESUME-ask undo cannot `--resume` the undone message', async () => {
    // Establish a session: a first ask that reaches a SUCCESSFUL terminal persists cli_session_id.
    const first = await askK('what is on my calendar')
    eventBus.emitRunUpdate({ id: first.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    const sid = threadSessionId()
    expect(sid).toBeTruthy()

    // A RESUME ask is dispatched INTO that live session (`--resume <sid>`), so the message is
    // already in K's CLI context before it even lands durably. Undo BEFORE it terminates —
    // active_run_id still points at the run.
    const resume = await askK('add a dentist appointment on Tuesday')
    expect(lastPersistentSession()).toMatchObject({ sessionId: sid, resume: true })
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBe(resume.runId)

    undoK(resume.runId)

    // DB row: the resume turn is gone AND the tainted session id is nulled (not merely the turn
    // deleted). Without the session clear the undone message would survive in K's CLI context.
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.runId === resume.runId)).toHaveLength(0)
    expect(threadSessionId()).toBeNull()

    // Next-ask dispatch: with cli_session_id NULL the ask re-seeds FRESH — resume=false, a full
    // renderSeed transcript, a NEW session id — instead of `--resume`-ing the tainted one. So the
    // undone message is carried by NEITHER the transcript NOR the resumed session.
    const next = await askK('what else is on my calendar')
    expect(next.runId).not.toBe(resume.runId)
    const ps = lastPersistentSession()!
    expect(ps.resume).toBe(false)
    expect(ps.sessionId).not.toBe(sid)
    const prompt = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(prompt).toContain('You:') // full renderSeed, not a bare `--resume` message body
    expect(prompt).not.toContain('dentist appointment') // the undone message is not re-seeded
  })

  it('AFTER TERMINAL: nulls the tainted CLI session even when the resume run already finished (active_run_id gone)', async () => {
    // The primary real-world path: undo is a 5s toast tied to SEND time, and a fast one-shot
    // resume-ask ANSWERS-AND-EXITS inside that window — so captureAnswers has ALREADY nulled
    // active_run_id by the time the operator reads the bad reply and clicks Undo. An
    // active_run_id-keyed clear would match zero rows here and LEAK the taint; the thread-keyed
    // clear must still fire. (Regression the reviewer flagged; the original patch failed it.)
    const first = await askK('what is on my calendar')
    eventBus.emitRunUpdate({ id: first.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    const sid = threadSessionId()
    expect(sid).toBeTruthy()

    const resume = await askK('add a dentist appointment on Tuesday')
    expect(lastPersistentSession()).toMatchObject({ sessionId: sid, resume: true })

    // The resume run streams a reply then reaches terminal — captureAnswers nulls active_run_id
    // but (a RESUME ask carries no sessionIdToPersist) leaves cli_session_id = sid intact.
    eventBus.emitEvent({ id: uuid(), runId: resume.runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'Added the dentist appointment.' })
    eventBus.emitRunUpdate({ id: resume.runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)
    // Bug precondition: active_run_id is already gone, yet the tainted session persists.
    expect(getKThread(DEFAULT_K_THREAD_ID)!.activeRunId).toBeNull()
    expect(threadSessionId()).toBe(sid)

    undoK(resume.runId)

    // Thread-keyed clear still fires — the session is nulled and both undone turns are gone.
    expect(threadSessionId()).toBeNull()
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.runId === resume.runId)).toHaveLength(0)

    // Next ask re-seeds fresh (resume=false, a NEW session, full seed WITHOUT the undone message).
    await askK('what else is on my calendar')
    const ps = lastPersistentSession()!
    expect(ps.resume).toBe(false)
    expect(ps.sessionId).not.toBe(sid)
    const prompt = String(vi.mocked(startRun).mock.calls.at(-1)![0])
    expect(prompt).toContain('You:')
    expect(prompt).not.toContain('dentist appointment')
  })

  it('RACE: a LATE assistant/terminal flush after undoK does NOT resurrect an orphaned k reply', async () => {
    // The kill is fire-and-forget, so a still-streaming run can flush events AFTER undo.
    const { runId } = await askK('remind me to cancel the order')
    undoK(runId)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)

    // The dying process flushes a late assistant event, then its terminal — captureAnswers'
    // subscriber is still LIVE (undo does not tear it down). Without the undo gate this
    // appended an orphaned 'k' reply for a run whose 'user' ask is already gone.
    eventBus.emitEvent({ id: uuid(), runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'late partial reply' })
    eventBus.emitRunUpdate({ id: runId, status: 'killed', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    // No orphaned reply — the thread has NO turns for the undone run (nothing to reseed).
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.runId === runId)).toHaveLength(0)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
  })

  it('RACE: a Chief delegation terminal after undoK does NOT resurrect an orphaned report-back', async () => {
    // The SAME "no unsubscribe on kill" gap in reportDelegationBack's finalize path.
    const { runId } = await askK('fix the failing test suite') // escalates → chief + report-back wired
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID).filter(t => t.role === 'user')).toHaveLength(1)

    undoK(runId)
    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)

    // The Chief run files a report then terminates AFTER the undo — its subscriber is still
    // live. Without the gate this queued an orphaned report-back message (B.4: the terminal
    // must queue NOTHING once undoK removed the ask).
    fileChiefReport(runId, 'PR opened after undo')
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(0)
    expect(queuedMessages()).toHaveLength(0)
  })
})

describe('REGULAR-DISPATCH gating — the persistent session is K-only', () => {
  it('a delegated (escalating) ask does NOT thread a persistentSession — the Chief run stays a fresh-worktree dispatch', async () => {
    await askK('fix the failing test suite') // escalates → delegateToChief → startAgentRun('chief')
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    expect((call[1] as { persistentSession?: unknown }).persistentSession).toBeUndefined()
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
    // A real K→Chief delegation links the Chief run to the K thread (the derivable edge).
    const { runId: chiefRunId } = await askK('implement the payment flow')
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
    const { runId: chiefRunId } = await askK('implement the checkout flow')

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
  function seedTerminalPipeline(opts: { owner?: string | null; kRunId?: string | null; title?: string }): string {
    const pid = `mock-k-pipe-${uuid().slice(0, 8)}`
    const now = Date.now()
    pipelineDb.insertPipelineRun.run({
      id: pid,
      definitionId: 'ca-b4-def',
      projectId: null,
      title: opts.title ?? 'B4 pipeline',
      cwd: '.',
      baseCommit: 'deadbeef',
      createdAt: now,
      updatedAt: now,
      ownerProfileId: opts.owner ?? null,
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

  it('queues ONE message from the pipeline OWNER profile (provenance NULL) on terminal', async () => {
    // A real K→Chief delegation links the delegating run to the K thread.
    const { runId: kRunId } = await askK('fix the failing pipeline suite')
    const stop = continuePipelineOutcomeToK()
    try {
      const turnsBefore = listKThreadTurns(DEFAULT_K_THREAD_ID).length
      const pid = seedTerminalPipeline({ owner: 'ca-b-lead-prof', kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].to_profile_id).toBe('k-secretary')
      expect(msgs[0].to_thread_id).toBe(DEFAULT_K_THREAD_ID)
      expect(msgs[0].from_kind).toBe('profile')
      expect(msgs[0].from_profile_id).toBe('ca-b-lead-prof') // pipeline_runs.owner_profile_id
      expect(msgs[0].provenance_run_id).toBeNull() // no single run owns a multi-run pipeline
      expect(String(msgs[0].body)).toBe('Pipeline "B4 pipeline" completed.')

      // NO 'k' turn was appended directly.
      expect(listKThreadTurns(DEFAULT_K_THREAD_ID)).toHaveLength(turnsBefore)
    } finally {
      stop()
    }
  })

  it('owner NULL → falls back to the delegating K run\'s profile', async () => {
    // askK's escalating delegation gives the k_run an agent_runs row (profile 'chief').
    const { runId: kRunId } = await askK('fix the failing pipeline suite again')
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: null, kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_profile_id).toBe('chief')
      expect(msgs[0].provenance_run_id).toBeNull()
    } finally {
      stop()
    }
  })

  it('owner NULL + no activation row on the delegating run → falls back to k-secretary', () => {
    const kRunId = seedBareDelegatingKRun()
    const stop = continuePipelineOutcomeToK()
    try {
      const pid = seedTerminalPipeline({ owner: null, kRunId })
      maybeFinalizePipeline(pid)

      const msgs = queuedMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].from_profile_id).toBe('k-secretary')
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
