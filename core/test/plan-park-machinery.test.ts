/**
 * P2 A1 — plan park / approve / discard / boot-sweep state machine.
 * synthesizeConfigDir is mocked to RECORD opts then THROW (w8b precedent), so the
 * approve happy path proves the session-resume wiring (runDirOverride = the
 * preserved agentRunDir, persist:true) with NO claude spawn. NOTE: the factory is
 * hoisted — reference NO outer bindings inside it (P1 lesson #4).
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('p2-park-stop') }) }
})

import { db, runsDb, runPlansDb, eventsDb } from '../src/db.js'
import { agentRunDir, synthesizeConfigDir } from '../src/agent-config.js'
import {
  parkPlanRun, approvePlanRun, discardPlanRun, reconcileParkedPlanRuns, startRun,
} from '../src/supervisor.js'
import { DEFAULT_PROFILE } from '../src/profiles.js'
import type { Run } from '@k/shared'

const runIds: string[] = []
const dirs: string[] = []
afterAll(() => {
  for (const id of runIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* */ }
    try { db.prepare('DELETE FROM run_plans WHERE run_id = ?').run(id) } catch { /* */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* */ }
  }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* */ } }
})

/** Insert a run row + (optionally) a REAL parked substrate on disk. */
function seedRun(status: Run['status'], opts: { substrate?: boolean; sessionId?: string | null } = {}): { id: string; worktree: string } {
  const id = randomUUID()
  runIds.push(id)
  const worktree = path.join(agentRunDir(id), '..', `wt-${id.slice(0, 8)}`) // sibling temp dir under the data dir
  runsDb.insertRun.run({ id, prompt: 'plan-gated thing', cwd: 'C:\\nowhere', worktree,
    status, provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: null, createdAt: Date.now() })
  if (opts.sessionId !== null) runsDb.setRunCliSessionId.run(opts.sessionId ?? `sess-${id.slice(0, 8)}`, id)
  if (opts.substrate) {
    fs.mkdirSync(worktree, { recursive: true }); dirs.push(worktree)
    fs.mkdirSync(agentRunDir(id), { recursive: true }); dirs.push(agentRunDir(id))
  }
  return { id, worktree }
}

const PLAN_TEXT = 'I will do it.\n```json\n{"steps":[{"title":"make hello.js"}],"files":["hello.js"],"risk":"low"}\n```'

describe('parkPlanRun', () => {
  it('inserts the plan row (parsed doc + raw) and flips the run to awaiting_plan', () => {
    const { id } = seedRun('running')
    const run = { id, prompt: 'plan-gated thing', cwd: 'C:\\nowhere', status: 'running',
      provider: 'claude', model: 'm', tokensIn: 5, tokensOut: 7, costUsd: 0.01, createdAt: 1 } as Run
    parkPlanRun(run, PLAN_TEXT, DEFAULT_PROFILE)
    const row = runsDb.getRun.get(id) as { status: string }
    expect(row.status).toBe('awaiting_plan')
    const plan = runPlansDb.getRunPlan.get(id) as { plan: string; raw: string; edited: number; profile_id: string | null }
    expect(JSON.parse(plan.plan).risk).toBe('low')
    expect(plan.raw).toContain('make hello.js')
    expect(plan.edited).toBe(0)
    expect(plan.profile_id).toBeNull() // DEFAULT_PROFILE dispatches store null
  })
  it('degrades to plan=null (raw kept) when the turn has no parseable fence', () => {
    const { id } = seedRun('running')
    parkPlanRun({ id, prompt: 'x', cwd: 'C:\\n', status: 'running', provider: 'claude',
      model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1 } as Run, 'I forgot the json, sorry.', DEFAULT_PROFILE)
    const plan = runPlansDb.getRunPlan.get(id) as { plan: string | null; raw: string }
    expect(plan.plan).toBeNull()
    expect(plan.raw).toContain('forgot the json')
  })
})

describe('reconcileParkedPlanRuns (boot sweep)', () => {
  it('keeps intact parks; flips broken parks (missing dirs / session) to interrupted', () => {
    const intact = seedRun('awaiting_plan', { substrate: true })
    const noDirs = seedRun('awaiting_plan') // row only — substrate never created
    const noSession = seedRun('awaiting_plan', { substrate: true, sessionId: null })
    const swept = reconcileParkedPlanRuns()
    expect(swept).toBeGreaterThanOrEqual(2)
    expect((runsDb.getRun.get(intact.id) as { status: string }).status).toBe('awaiting_plan')
    expect((runsDb.getRun.get(noDirs.id) as { status: string }).status).toBe('interrupted')
    expect((runsDb.getRun.get(noSession.id) as { status: string }).status).toBe('interrupted')
  })
})

describe('approvePlanRun', () => {
  it('404 unknown · 409 not-awaiting · 410 broken substrate (flips it interrupted)', async () => {
    expect((await approvePlanRun(randomUUID())).ok).toBe(false)
    const done = seedRun('done')
    expect(await approvePlanRun(done.id)).toMatchObject({ ok: false, code: 409 })
    const broken = seedRun('awaiting_plan') // no substrate on disk
    runPlansDb.insertRunPlan.run({ runId: broken.id, plan: null, raw: 'r', edited: 0, profileId: null, createdAt: 1, updatedAt: 1 })
    expect(await approvePlanRun(broken.id)).toMatchObject({ ok: false, code: 410 })
    expect((runsDb.getRun.get(broken.id) as { status: string }).status).toBe('interrupted')
  })

  it('happy path: CAS claims the park, stamps approval, re-seeds seq, resumes against the PRESERVED dir; double-send loses 409', async () => {
    const parked = seedRun('awaiting_plan', { substrate: true })
    runPlansDb.insertRunPlan.run({ runId: parked.id, plan: JSON.stringify({ steps: [{ title: 's' }], files: [], risk: 'low' }),
      raw: 'r', edited: 1, profileId: null, createdAt: 1, updatedAt: 2 })
    // Simulate a reboot-cold seq counter with pre-existing events at seq 0..4:
    for (let s = 0; s < 5; s++) {
      eventsDb.insertEvent.run({ id: randomUUID(), runId: parked.id, seq: s, type: 'status', ts: 1, raw: null,
        text: 'running', tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null, toolKind: null,
        toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null })
    }
    const [first, second] = await Promise.all([approvePlanRun(parked.id), approvePlanRun(parked.id)])
    const oks = [first, second].filter(r => r.ok)
    expect(oks).toHaveLength(1)                         // E-02 double-send: exactly one winner
    expect([first, second].find(r => !r.ok)).toMatchObject({ ok: false, code: 409 })
    expect((runPlansDb.getRunPlan.get(parked.id) as { approved_at: number | null }).approved_at).not.toBeNull()
    // The continuation user event landed at seq >= 5 (counter re-seeded, not colliding):
    const evs = eventsDb.listEvents.all(parked.id) as Array<{ seq: number; type: string; text: string | null }>
    const userTurn = evs.find(e => e.type === 'user')
    expect(userTurn).toBeDefined()
    expect(userTurn!.seq).toBeGreaterThanOrEqual(5)
    expect(userTurn!.text).toContain('REVIEWED AND EDITED')
    // Resume wiring: synthesize was called re-targeting the preserved dir.
    await new Promise(r => setTimeout(r, 30)) // let runAgent reach synthesize (w8b settle idiom)
    const call = vi.mocked(synthesizeConfigDir).mock.calls.at(-1)
    expect(call).toBeDefined()
    expect((call![1] as { runDirOverride?: string; persist?: boolean }).runDirOverride).toBe(agentRunDir(parked.id))
    expect((call![1] as { persist?: boolean }).persist).toBe(true)
  })
})

describe('discardPlanRun', () => {
  it('flips the park to killed, removes the substrate, keeps the plan row as history; 409 when not parked', async () => {
    const parked = seedRun('awaiting_plan', { substrate: true })
    runPlansDb.insertRunPlan.run({ runId: parked.id, plan: null, raw: 'r', edited: 0, profileId: null, createdAt: 1, updatedAt: 1 })
    const res = await discardPlanRun(parked.id)
    expect(res.ok).toBe(true)
    expect((runsDb.getRun.get(parked.id) as { status: string }).status).toBe('killed')
    expect(fs.existsSync(agentRunDir(parked.id))).toBe(false)
    expect(runPlansDb.getRunPlan.get(parked.id)).toBeDefined()
    expect(await discardPlanRun(parked.id)).toMatchObject({ ok: false, code: 409 })
  })
})

// Step 7(c): the worktree-fallback degrade. A planGate dispatch on a NON-GIT cwd
// leaves run.worktree undefined (inWorktree false), so a park there would be
// permanently unapprovable — the run must proceed as an honest ungated one-shot
// and NEVER reach awaiting_plan. The mocked synthesize throws, so runAgent errors
// out immediately after the (degraded, planGate=false) launch; the assertion is
// that no park ever happened. This exercises the real startRun seam end to end.
describe('startRun planGate degrade (worktree fallback)', () => {
  it('a planGate dispatch on a NON-GIT cwd never parks and leaves run_plans empty', async () => {
    const cwd = path.join(os.tmpdir(), `k-p2a-nogit-${randomUUID().slice(0, 8)}`)
    fs.mkdirSync(cwd, { recursive: true }); dirs.push(cwd)
    const run = await startRun('do a thing', { planGate: true, cwd })
    runIds.push(run.id)
    // Let the background runAgent reach (and throw in) the mocked synthesize.
    await new Promise(r => setTimeout(r, 60))
    const row = runsDb.getRun.get(run.id) as { status: string }
    expect(row.status).not.toBe('awaiting_plan')             // degrade fired — never parked
    expect(runPlansDb.getRunPlan.get(run.id)).toBeUndefined() // no plan row was ever written
  })
})
