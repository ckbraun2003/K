/**
 * Continuous Agents A.3 (D-127) — runs.kind + runs.session_id: the startRun
 * stamp (explicit kind > persistentSession inference > 'job'), the kind-keyed
 * budget exemption in startAgentRun, the GET /api/runs ?kind filter, and the
 * kind/sessionId response mapping.
 *
 * Mock-free dispatch: synthesizeConfigDir is mocked to THROW before any claude
 * spawn (the carry-persistent-session.test.ts seam), so the REAL startRun
 * inserts its runs row (the assertion target) and the aborted runAgent never
 * launches a process. Non-session dispatches pass a throwaway NON-git cwd so
 * the worktree branch falls back to running in cwd (no `git worktree add`
 * against the shared repo).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'

// synthesizeConfigDir throws before any claude spawn (runAgent reaches it, then
// aborts); everything else in agent-config stays real (the persistent-session
// path needs the real kSecretaryConfigPaths/agentSessionPaths).
vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('runs-kind-wiring-stop') }) }
})

// Must be set BEFORE importing index.ts (beforeAll) so the top-level start() is skipped.
process.env.K_SKIP_BOOTSTRAP = '1'

const { db, runsDb } = await import('../src/db.js')
const { startRun } = await import('../src/supervisor.js')
const { startAgentRun } = await import('../src/agent-runs.js')
const { BudgetCapError, budgetStatus } = await import('../src/budget-governor.js')
const { setAutonomySettings, __resetConfigCache } = await import('../src/config-store.js')
const { getProfile, createProfile } = await import('../src/profiles.js')

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const PROFILE = 'a3-kind-lead'
const MODEL = 'claude-sonnet-4-6'

const AUTONOMY_OFF = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, budgetWarnPct: 0.8,
} as const

const runIds: string[] = []
const tmpDirs: string[] = []
let createdProfile = false
let app: FastifyInstance

/** Let the aborted runAgent body settle (the mock throws before any spawn). */
const settle = () => new Promise(r => setTimeout(r, 30))

/** A throwaway NON-git cwd → startRun's worktree add fails → runs in cwd. */
function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-a3-kind-'))
  tmpDirs.push(d)
  return d
}

function runRow(id: string): { kind: string; session_id: string | null } {
  return db.prepare('SELECT kind, session_id FROM runs WHERE id = ?').get(id) as { kind: string; session_id: string | null }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  // startAgentRun resolves the profile; guard-create so the shared roster is untouched.
  if (!getProfile(PROFILE)) {
    createProfile({ id: PROFILE, name: 'A3 Kind Lead', tier: 'orchestrator' })
    createdProfile = true
  }
}, 60_000) // cold module-graph import in isolation can exceed the 10s hook default

afterAll(async () => {
  db.prepare('DELETE FROM agent_runs WHERE profile_id = ?').run(PROFILE)
  for (const id of runIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  if (createdProfile) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(PROFILE)
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  await app?.close()
})

describe('startRun stamps runs.kind + runs.session_id (A.3, D-127)', () => {
  it('1) a default dispatch is a job: kind=job, session_id NULL', async () => {
    const run = await startRun('a3 default dispatch', { model: MODEL, cwd: tmpCwd() })
    runIds.push(run.id)
    expect(run.kind).toBe('job')
    expect(run.sessionId).toBeUndefined()
    const row = runRow(run.id)
    expect(row.kind).toBe('job')
    expect(row.session_id).toBeNull()
    await settle()
  })

  it("2) a persistentSession dispatch infers kind='chat-turn'", async () => {
    const run = await startRun('a3 chat turn', {
      model: MODEL,
      persistentSession: { key: 'a3-kind-thread-2', sessionId: uuid(), resume: false },
    })
    runIds.push(run.id)
    expect(run.kind).toBe('chat-turn')
    expect(runRow(run.id).kind).toBe('chat-turn')
    await settle()
  })

  it('3) an explicit kind wins — even over the persistentSession inference', async () => {
    // Bare explicit kind (no session): stamped verbatim.
    const bare = await startRun('a3 stage bare', { model: MODEL, cwd: tmpCwd(), kind: 'pipeline-stage' })
    runIds.push(bare.id)
    expect(bare.kind).toBe('pipeline-stage')
    expect(runRow(bare.id).kind).toBe('pipeline-stage')

    // Explicit kind + persistentSession: explicit wins over the chat-turn inference.
    const both = await startRun('a3 stage over session', {
      model: MODEL,
      kind: 'pipeline-stage',
      persistentSession: { key: 'a3-kind-thread-3', sessionId: uuid(), resume: false },
    })
    runIds.push(both.id)
    expect(both.kind).toBe('pipeline-stage')
    expect(runRow(both.id).kind).toBe('pipeline-stage')
    await settle()
  })

  it("4) the sessionId opt stamps runs.session_id", async () => {
    const run = await startRun('a3 session stamp', {
      model: MODEL,
      sessionId: 'sess-1',
      persistentSession: { key: 'a3-kind-thread-4', sessionId: uuid(), resume: false },
    })
    runIds.push(run.id)
    expect(run.sessionId).toBe('sess-1')
    expect(runRow(run.id).session_id).toBe('sess-1')
    await settle()
  })
})

describe('the budget-gate exemption keys on kind (A.3, D-127)', () => {
  it('5) a capped org blocks a plain delegation but NEVER a chat turn', async () => {
    // Cap the org just ABOVE its current measured spend, then push a run OVER it
    // (the budget-gate suites' relative-cap idiom — immune to shared-DB history).
    const baseline = budgetStatus().org.spentUsd
    setAutonomySettings({ ...AUTONOMY_OFF, orgDailyBudgetUsd: baseline + 0.5 })
    __resetConfigCache()
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, worktree, status, cost_usd, created_at)
       VALUES ('a3-bg-over', 'p', '.', '.', 'done', 1, ?)`,
    ).run(Date.now())
    runIds.push('a3-bg-over')
    try {
      expect(budgetStatus().org.state).toBe('capped')

      // A session send (persistentSession → kind 'chat-turn') is exempt: the
      // operator's conversation channel must stay reachable to raise the cap.
      const viaSession = await startAgentRun(PROFILE, {
        trigger: 'delegation',
        goal: 'a3 exempt via session',
        persistentSession: { key: 'a3-kind-thread-5', sessionId: uuid(), resume: false },
      })
      runIds.push(viaSession.runId)

      // The exemption is the KIND, not the persistentSession opt itself: an
      // explicit chat-turn without a session is exempt too (the A.3 reword).
      const viaKind = await startAgentRun(PROFILE, {
        trigger: 'delegation',
        goal: 'a3 exempt via kind',
        kind: 'chat-turn',
        cwd: tmpCwd(),
      })
      runIds.push(viaKind.runId)

      // A plain delegation is a paid org dispatch (kind 'job') → BudgetCapError.
      await expect(
        startAgentRun(PROFILE, { trigger: 'delegation', goal: 'a3 gated', cwd: tmpCwd() }),
      ).rejects.toBeInstanceOf(BudgetCapError)
    } finally {
      db.prepare(`DELETE FROM runs WHERE id = 'a3-bg-over'`).run()
      setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
      __resetConfigCache()
    }
    await settle()
  })
})

describe('GET /api/runs — ?kind filter + kind/sessionId mapping (A.3, D-127)', () => {
  const P = `a3kind-${Date.now()}`
  const seeded = [
    { id: uuid(), kind: 'job', sessionId: null, prompt: `${P} job`, offset: 0 },
    { id: uuid(), kind: 'chat-turn', sessionId: 'sess-map', prompt: `${P} chat`, offset: 1 },
    { id: uuid(), kind: 'pipeline-stage', sessionId: null, prompt: `${P} stage`, offset: 2 },
  ]

  beforeAll(() => {
    for (const s of seeded) {
      runsDb.insertRun.run({
        id: s.id, prompt: s.prompt, cwd: '/tmp/a3', worktree: null, status: 'done',
        provider: 'claude', model: MODEL, tokensIn: 0, tokensOut: 0, costUsd: 0,
        projectId: null, kind: s.kind, sessionId: s.sessionId, createdAt: Date.now() + s.offset,
      })
      runIds.push(s.id)
    }
  })

  async function fetchMine(qs: string): Promise<Array<Record<string, unknown>>> {
    const res = await app.inject({ method: 'GET', url: `/api/runs${qs}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    return (res.json() as Array<Record<string, unknown>>).filter(r => String(r.prompt).startsWith(P))
  }

  it('7a) ?kind=job returns only jobs', async () => {
    const mine = await fetchMine('?kind=job&limit=500')
    expect(mine).toHaveLength(1)
    expect(mine[0].kind).toBe('job')
  })

  it('7b) ?kind=job,pipeline-stage returns both — and no chat turns', async () => {
    const mine = await fetchMine('?kind=job,pipeline-stage&limit=500')
    expect(mine).toHaveLength(2)
    expect(mine.map(r => r.kind).sort()).toEqual(['job', 'pipeline-stage'])
  })

  it('7c) ?kind=nope → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?kind=nope', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })

  it('7d) no ?kind → every kind (byte-compatible with the pre-A.3 list)', async () => {
    const mine = await fetchMine('?limit=500')
    expect(mine).toHaveLength(3)
    expect(mine.map(r => r.kind).sort()).toEqual(['chat-turn', 'job', 'pipeline-stage'])
  })

  it('8) dbRowToRun carries kind and sessionId', async () => {
    const chat = seeded.find(s => s.kind === 'chat-turn')!
    const res = await app.inject({ method: 'GET', url: `/api/runs/${chat.id}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().kind).toBe('chat-turn')
    expect(res.json().sessionId).toBe('sess-map')

    // A sessionless job maps sessionId → absent (undefined), not null.
    const job = seeded.find(s => s.kind === 'job')!
    const jobRes = await app.inject({ method: 'GET', url: `/api/runs/${job.id}`, headers: AUTH })
    expect(jobRes.statusCode).toBe(200)
    expect(jobRes.json().kind).toBe('job')
    expect('sessionId' in jobRes.json()).toBe(false)
  })
})
