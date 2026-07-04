/**
 * lead-dispatch-relay.ts — project-scope resolution + throw-path hardening (B1).
 *
 * Before B1 the drain ignored the assignment's scope_projects — every lead ran in
 * K's own repo. Now resolveDispatchScope maps the FIRST scoped name through the
 * projects registry to the dispatch's projectId + cwd (fail-closed: an
 * unresolvable name or missing localPath FAILS the dispatch cleanly), and a
 * post-dispatch wiring throw that strands the intent 'dispatched' with no
 * lead_run_id is rescued immediately (status-guarded mark-failed).
 *
 * Mirrors lead-dispatch-relay.test.ts's mocking idiom: supervisor.startRun is
 * mocked (inserts a real runs row — the FK targets) and its (prompt, opts) args
 * are read back via vi.mocked(startRun).mock.calls so the tests can assert the
 * cwd/projectId actually passed to the dispatch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, mgmtDb, leadDispatchDb, workflowRunsDb, workflowStepsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { seedProfiles } from '../src/profiles.js'
import { seedWorkflowDefinitions } from '../src/workflow-defs.js'
import type { Assignment, Run } from '@k/shared'

// startRun mocked so no real agent spawns, but it MUST insert a real runs row:
// agent_runs.run_id / lead_dispatches.lead_run_id / mgmt_assignments.lead_run_id all FK → runs(id).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-scope-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'scope', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Modules under test — imported AFTER the mock so the transitive supervisor is mocked.
const { mgmtTools } = await import('../src/mcp/mgmt.js')
const { drainLeadDispatches, resolveDispatchScope } = await import('../src/lead-dispatch-relay.js')
const { getProjectByName } = await import('../src/projects.js')

// ── fixtures + helpers ────────────────────────────────────────────────────────

const CHIEF_RUN = uuid()

// Two registry rows inserted directly: one whose local_path is a REAL directory,
// one whose local_path is missing on disk. Unique suffixed names (projects.name UNIQUE).
const SUFFIX = uuid().slice(0, 8)
const GOOD_PROJECT_ID = `b1-scope-good-${SUFFIX}`
const GOOD_PROJECT_NAME = `b1-scope-good-${SUFFIX}`
const BAD_PROJECT_ID = `b1-scope-bad-${SUFFIX}`
const BAD_PROJECT_NAME = `b1-scope-bad-${SUFFIX}`
let goodDir = ''
const badDir = path.join(os.tmpdir(), `k-b1-scope-missing-${SUFFIX}`) // never created

type Ctx = { runId: string | null }
const ctxChief: Ctx = { runId: CHIEF_RUN }

function call(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

interface DispatchResult { dispatchId: string }

/** Record an intent for a fresh Frontend assignment, optionally project-scoped. */
function recordIntent(objective: string, projects?: string[]): { assignmentId: string; dispatchId: string } {
  const assigned = call('assign_lead', { lead: 'Frontend', objective }, ctxChief) as Assignment
  if (projects) call('scope_projects', { assignmentId: assigned.id, projects }, ctxChief)
  const res = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as DispatchResult
  return { assignmentId: assigned.id, dispatchId: res.dispatchId }
}

const intent = (dispatchId: string) => leadDispatchDb.getLeadDispatch.get(dispatchId) as Record<string, unknown>
const assignmentLeadRun = (assignmentId: string) =>
  (mgmtDb.getAssignment.get(assignmentId) as Record<string, unknown>).lead_run_id

/** The startRun mock's calls made AFTER `from` (index into mock.calls). */
const startRunCallsSince = (from: number) => vi.mocked(startRun).mock.calls.slice(from)

/** Let a fire-and-forget lifecycle settle (the report-back rides the async seam). */
const flush = () => new Promise(r => setTimeout(r, 30))
/** A terminal Run event for `id` (minimal shape the run-lifecycle seam reads). */
const terminalRun = (id: string, status: Run['status'] = 'done'): Run =>
  ({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 }) as Run

beforeAll(() => {
  seedProfiles()
  seedWorkflowDefinitions()
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'scope', '.', 'running', ?)`,
  ).run(CHIEF_RUN, Date.now())
  goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-b1-scope-good-'))
  db.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
    .run(GOOD_PROJECT_ID, GOOD_PROJECT_NAME, goodDir, Date.now())
  db.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
    .run(BAD_PROJECT_ID, BAD_PROJECT_NAME, badDir, Date.now())
})

afterAll(() => {
  // FK-safe order: lead_dispatches → mgmt_reports → mgmt_assignments → agent_runs → runs → projects.
  db.prepare(`DELETE FROM lead_dispatches WHERE chief_run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-scope-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-scope-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM projects WHERE id IN (?, ?)`).run(GOOD_PROJECT_ID, BAD_PROJECT_ID)
  try { fs.rmSync(goodDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── resolveDispatchScope (pure resolver) ─────────────────────────────────────

describe('resolveDispatchScope', () => {
  it('zero names → K-repo default (projectId null, no cwd, no error)', () => {
    expect(resolveDispatchScope([])).toEqual({ projectId: null })
  })

  it('one resolvable name → the project id + its localPath as cwd', () => {
    const scope = resolveDispatchScope([GOOD_PROJECT_NAME])
    expect(scope.projectId).toBe(GOOD_PROJECT_ID)
    expect(scope.cwd).toBe(goodDir)
    expect(scope.error).toBeUndefined()
    expect(scope.warning).toBeUndefined()
  })

  it('a registered project whose localPath is missing on disk → error (fail-closed)', () => {
    const scope = resolveDispatchScope([BAD_PROJECT_NAME])
    expect(scope.projectId).toBeNull()
    expect(scope.error).toMatch(/localPath does not exist/)
  })

  it('an unknown name → error (fail-closed)', () => {
    const scope = resolveDispatchScope(['b1-no-such-project'])
    expect(scope.projectId).toBeNull()
    expect(scope.error).toMatch(/not found in the projects registry/)
  })

  it('multiple names → the FIRST wins, extras noted in a warning', () => {
    const scope = resolveDispatchScope([GOOD_PROJECT_NAME, BAD_PROJECT_NAME])
    expect(scope.projectId).toBe(GOOD_PROJECT_ID)
    expect(scope.cwd).toBe(goodDir)
    expect(scope.warning).toContain('using the first')
  })

  it('case-insensitive match applies when unambiguous (free-text Chief names)', () => {
    expect(getProjectByName(GOOD_PROJECT_NAME.toUpperCase())?.id).toBe(GOOD_PROJECT_ID)
    const scope = resolveDispatchScope([GOOD_PROJECT_NAME.toUpperCase()])
    expect(scope.projectId).toBe(GOOD_PROJECT_ID)
    expect(scope.cwd).toBe(goodDir)
  })
})

// ── drainLeadDispatches + scope ──────────────────────────────────────────────

describe('drainLeadDispatches: project scope', () => {
  it('a scoped assignment dispatches with the project cwd + projectId', async () => {
    const before = vi.mocked(startRun).mock.calls.length
    const { assignmentId, dispatchId } = recordIntent('B1-SCOPE-HAPPY', [GOOD_PROJECT_NAME])

    expect(await drainLeadDispatches()).toBe(1)

    const calls = startRunCallsSince(before)
    expect(calls).toHaveLength(1)
    const opts = calls[0][1] as Record<string, unknown>
    expect(opts.cwd).toBe(goodDir)
    expect(opts.projectId).toBe(GOOD_PROJECT_ID)

    const runId = String(assignmentLeadRun(assignmentId))
    expect(runId).toMatch(/^mock-scope-run-/)
    // The activation row carries the scoped project.
    const ar = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>
    expect(ar.project_id).toBe(GOOD_PROJECT_ID)
    expect(intent(dispatchId).status).toBe('dispatched')
  })

  it('zero scope → today\'s behavior: no cwd, no projectId (agent_runs.project_id NULL)', async () => {
    const before = vi.mocked(startRun).mock.calls.length
    const { assignmentId, dispatchId } = recordIntent('B1-SCOPE-NONE')

    expect(await drainLeadDispatches()).toBe(1)

    const calls = startRunCallsSince(before)
    expect(calls).toHaveLength(1)
    const opts = calls[0][1] as Record<string, unknown>
    expect(opts.cwd).toBeUndefined()
    expect(opts.projectId).toBeUndefined()

    const runId = String(assignmentLeadRun(assignmentId))
    const ar = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>
    expect(ar.project_id).toBeNull()
    expect(intent(dispatchId).status).toBe('dispatched')
  })

  it('a scoped project with a missing localPath fails the dispatch cleanly (no run)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = vi.mocked(startRun).mock.calls.length
      const { assignmentId, dispatchId } = recordIntent('B1-SCOPE-BADPATH', [BAD_PROJECT_NAME])

      expect(await drainLeadDispatches()).toBe(0)

      expect(startRunCallsSince(before)).toHaveLength(0) // startRun never called
      expect(intent(dispatchId).status).toBe('failed')
      expect(intent(dispatchId).lead_run_id).toBeNull()
      expect(assignmentLeadRun(assignmentId)).toBeNull() // retryable
    } finally {
      warn.mockRestore()
    }
  })

  it('an unresolvable scoped name fails the dispatch cleanly (no run)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = vi.mocked(startRun).mock.calls.length
      const { assignmentId, dispatchId } = recordIntent('B1-SCOPE-GHOST', ['no-such-project'])

      expect(await drainLeadDispatches()).toBe(0)

      expect(startRunCallsSince(before)).toHaveLength(0)
      expect(intent(dispatchId).status).toBe('failed')
      expect(assignmentLeadRun(assignmentId)).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('multi-project scope: the first project\'s cwd is used, a warning is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = vi.mocked(startRun).mock.calls.length
      const { dispatchId } = recordIntent('B1-SCOPE-MULTI', [GOOD_PROJECT_NAME, BAD_PROJECT_NAME])

      expect(await drainLeadDispatches()).toBe(1)

      const calls = startRunCallsSince(before)
      expect(calls).toHaveLength(1)
      expect((calls[0][1] as Record<string, unknown>).cwd).toBe(goodDir)
      expect(intent(dispatchId).status).toBe('dispatched')
      expect(warn.mock.calls.some(c => String(c[0]).includes('using the first'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

// ── throw-path hardening ──────────────────────────────────────────────────────

describe('drainLeadDispatches: scope-resolution throw (post-claim)', () => {
  it('a throw from the assignment read marks the intent failed — never stranded — and the drain continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = recordIntent('B1-SCOPE-THROW-A')
    const b = recordIntent('B1-SCOPE-THROW-B')
    // Deterministic drain order (listPendingLeadDispatches is created_at ASC with no
    // tie-break): pin A strictly before B.
    db.prepare(`UPDATE lead_dispatches SET created_at = 1 WHERE id = ?`).run(a.dispatchId)
    db.prepare(`UPDATE lead_dispatches SET created_at = 2 WHERE id = ?`).run(b.dispatchId)
    // The drain's FIRST assignment read (intent A, AFTER its CAS claim) throws — e.g.
    // SQLITE_BUSY under lock contention.
    const spy = vi.spyOn(mgmtDb.getAssignment, 'get').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    try {
      const before = vi.mocked(startRun).mock.calls.length
      // The drain NEVER throws (its contract): A degrades, B still dispatches.
      await expect(drainLeadDispatches()).resolves.toBe(1)

      // A: claimed then rescued to 'failed' (lead_run_id NULL, assignment retryable) —
      // NOT stranded 'dispatched' until the boot-only reconcile.
      expect(intent(a.dispatchId).status).toBe('failed')
      expect(intent(a.dispatchId).lead_run_id).toBeNull()
      expect(assignmentLeadRun(a.assignmentId)).toBeNull()
      // B: the loop continued past A's throw and dispatched normally.
      expect(intent(b.dispatchId).status).toBe('dispatched')
      expect(startRunCallsSince(before)).toHaveLength(1)
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})

describe('drainLeadDispatches: wiring-throw rescue', () => {
  it('a setLeadDispatchRun throw marks the intent failed instead of stranding it dispatched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(leadDispatchDb.setLeadDispatchRun, 'run').mockImplementationOnce(() => {
      throw new Error('wire-fail')
    })
    try {
      const before = vi.mocked(startRun).mock.calls.length
      const { dispatchId } = recordIntent('B1-SCOPE-WIREFAIL')

      // The drain must not throw — the run is live, only the bookkeeping failed.
      await expect(drainLeadDispatches()).resolves.toBe(1)

      // The run itself WAS started (the dispatch happened)…
      expect(startRunCallsSince(before)).toHaveLength(1)
      // …but the intent was rescued to 'failed' (lead_run_id NULL), not stranded
      // 'dispatched' until a reboot sweep — the Chief can re-dispatch.
      expect(intent(dispatchId).status).toBe('failed')
      expect(intent(dispatchId).lead_run_id).toBeNull()
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })

  it('a workflow-run SEED throw degrades to no-checklist but STILL fires the report-back (F-070 guard)', async () => {
    // REGRESSION: seedLeadWorkflowRun runs in the SAME wiring try, BETWEEN the bookkeeping
    // writes and the report-back hops. Unguarded, a seed throw (e.g. SQLITE_BUSY) fell through
    // to the outer catch and SKIPPED reportLeadOutcomeToChief / continueLeadOutcomeToK — silently
    // dropping the LIVE lead run's outcome with no recovery (lead_run_id is already set, so the
    // boot sweep can't rescue it). The seed is now isolated: it degrades to "no checklist" and the
    // report-back must still be wired. This FAILS against the pre-guard code.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Make the seed throw AFTER setAssignmentLeadRun succeeds: its first write is insertWorkflowRun.
    const spy = vi.spyOn(workflowRunsDb.insertWorkflowRun, 'run').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    try {
      const { assignmentId, dispatchId } = recordIntent('B1-SEED-THROW', [GOOD_PROJECT_NAME])

      // The drain never throws and still counts the successful dispatch.
      await expect(drainLeadDispatches()).resolves.toBe(1)

      const runId = String(assignmentLeadRun(assignmentId))
      expect(runId).toMatch(/^mock-scope-run-/)
      // The seed failed → no checklist bound to the run (accepted degrade)…
      expect(workflowStepsDb.getWorkflowRunByRunId.get(runId)).toBeUndefined()
      // …but the intent is intact (dispatched, run recorded) — NOT stranded/failed.
      expect(intent(dispatchId).status).toBe('dispatched')
      expect(intent(dispatchId).lead_run_id).toBe(runId)

      // The report-back was STILL wired: the lead terminal files a report UP to the Chief.
      eventBus.emitRunUpdate(terminalRun(runId, 'done'))
      await flush()
      const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 50) as Array<Record<string, unknown>>
      expect(reports.some(r => String(r.body).includes('Lead') && String(r.body).includes('completed'))).toBe(true)
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})
