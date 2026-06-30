/**
 * Task 7 — verification orchestration + routes + persistence.
 *
 * Pure-unit coverage for the engine lives in verify.test.ts; this file exercises
 * the impure conductor (runVerification): the persistence round-trip, the
 * deduped findings contract, the verification_update broadcast, the route 404,
 * and the score_breakdown migration.
 *
 * DB-touching tests reuse the production `db` singleton (the established pattern
 * in db-migration.test.ts) and clean up their rows in afterAll. We point each
 * project at a fresh temp dir with NO workflow/bible/remote so the FS/git
 * gatherers return deterministic facts without depending on the harness repo.
 */
import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db, projectsDb, verificationDb, rowToReport, migrate } from '../src/db.js'
import { runVerification } from '../src/verify.js'
import { getProject } from '../src/projects.js'
import { projectsRoutes } from '../src/routes/projects.js'
import { eventBus } from '../src/events.js'
import type { Project, WsMessage } from '@k/shared'

// Mock the supervisor so the deep-verify route never actually spawns claude.
// Hoisted by vitest above the imports; the route imports startRun from here.
vi.mock('../src/supervisor.js', () => ({
  startRun: vi.fn(async () => ({ id: 'mock-run' })),
}))
import { startRun } from '../src/supervisor.js'
const startRunMock = vi.mocked(startRun)

// ── temp dirs + project rows we create, cleaned up after the suite ─────────────

const tmpDirs: string[] = []
const projectIds: string[] = []

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-verify-'))
  tmpDirs.push(d)
  return d
}

/** Insert a bare project (no workflow/bible/remote) into the production db. */
function insertBareProject(): Project {
  const project: Project = {
    id: uuid(),
    name: `verify-test-${uuid().slice(0, 8)}`,
    localPath: makeTmp(),
    githubRemote: undefined,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
  projectsDb.insertProject.run({
    id: project.id,
    name: project.name,
    localPath: project.localPath,
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: project.bibleDir,
    createdAt: project.createdAt,
  })
  projectIds.push(project.id)
  return project
}

afterAll(() => {
  for (const id of projectIds) {
    db.prepare('DELETE FROM verification_reports WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ── orchestration round-trip ───────────────────────────────────────────────────

describe('runVerification — persistence round-trip', () => {
  it('persists a report, updates project health, and round-trips breakdown', () => {
    const project = insertBareProject()
    const report = runVerification(project)

    // a report row was persisted
    const rows = verificationDb.listVerificationReports.all(project.id) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const persisted = rowToReport(rows[0])
    expect(persisted.id).toBe(report.id)
    expect(persisted.score).toBe(report.score)
    // Task 8: a bare project has no workflow, so runVerification scaffolds a
    // starter ci.yml and records it in fixesApplied (persisted with the report).
    expect(report.fixesApplied).toEqual(['scaffolded CI workflow: .github/workflows/ci.yml'])
    expect(persisted.fixesApplied).toEqual(report.fixesApplied)
    // the file was actually written into the project's working tree
    expect(fs.existsSync(path.join(project.localPath, '.github', 'workflows', 'ci.yml'))).toBe(true)
    // the SCORE still reflects CI-MISSING this run — the scaffold does not
    // retroactively fix it (ci component 0, score 20).
    expect(report.breakdown.ci).toBe(0)
    expect(report.score).toBe(20)

    // project health + last_verified_at were updated
    const updated = getProject(project.id)
    expect(updated?.healthScore).toBe(report.score)
    expect(updated?.lastVerifiedAt).toBe(report.completedAt)

    // breakdown round-trips through the DB AND has the concrete expected values
    // for a bare project (no workflow/bible/remote, coverage unknown): ci 0,
    // coverage 20 (neutral), bible 0, findings 20−3·10 floored to 0.
    expect(report.breakdown).toEqual({ ci: 0, coverage: 20, bible: 0, findings: 0 })
    expect(persisted.breakdown).toEqual(report.breakdown)
  })
})

// ── live coverage trend (F4.W1) ──────────────────────────────────────────────────

describe('runVerification — live coverage trend', () => {
  function writeCoverage(localPath: string, pct: number): void {
    fs.mkdirSync(path.join(localPath, 'coverage'), { recursive: true })
    fs.writeFileSync(
      path.join(localPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { pct } } }),
    )
  }

  function persistedById(projectId: string, reportId: string) {
    const rows = verificationDb.listVerificationReports.all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToReport).find(r => r.id === reportId)
  }

  it('reads coverage-summary.json, persists coveragePct, and a real decline lowers the score', () => {
    const project = insertBareProject()

    // First reading: 90%. No prior report → 'stable' → coverage component full (20).
    writeCoverage(project.localPath, 90)
    const first = runVerification(project)
    expect(first.coveragePct).toBe(90)
    expect(first.breakdown.coverage).toBe(20)
    expect(persistedById(project.id, first.id)?.coveragePct).toBe(90)

    // Second reading: 80% (< prior 90 by > tol) → 'declining' → coverage half (10).
    writeCoverage(project.localPath, 80)
    const second = runVerification(project)
    expect(second.coveragePct).toBe(80)
    expect(second.breakdown.coverage).toBe(10)
    // the live decline really lowers the score vs. the stable first run.
    expect(second.score).toBeLessThan(first.score)
    expect(persistedById(project.id, second.id)?.coveragePct).toBe(80)
  })
})

// ── findings composition (dedupe contract) ──────────────────────────────────────

describe('runVerification — deduped findings', () => {
  it('counts the missing-workflow root cause exactly once across ci + invariants', () => {
    const project = insertBareProject() // no workflow, no bible, no remote
    const report = runVerification(project)

    // exactly one finding blames the missing workflow in the SCORED set — the
    // ci-area critical — NOT a second invariants-area copy.
    const workflowFindings = report.findings.filter(f => /workflow/i.test(f.message))
    expect(workflowFindings).toHaveLength(1)
    expect(workflowFindings[0].area).toBe('ci')

    // likewise the missing bible is owned by the bible area, not duplicated
    const bibleFindings = report.findings.filter(f => f.area === 'bible' || /bible/i.test(f.message))
    expect(bibleFindings).toHaveLength(1)
    expect(bibleFindings[0].area).toBe('bible')

    // the only invariants finding is the GitHub-remote one (neither other auditor covers it)
    const invariantFindings = report.findings.filter(f => f.area === 'invariants')
    expect(invariantFindings).toHaveLength(1)
    expect(invariantFindings[0].message).toMatch(/GitHub remote/)

    // three criticals (no-workflow, no-bible, no-remote), no warns/info →
    // findings component = 20 − 3·10 floored at 0. coverage neutral (unknown=20),
    // ci none = 0, bible not fresh = 0 ⇒ score = 0 + 20 + 0 + 0 = 20.
    const criticals = report.findings.filter(f => f.severity === 'critical')
    expect(criticals).toHaveLength(3)
    expect(report.breakdown).toEqual({ ci: 0, coverage: 20, bible: 0, findings: 0 })
    expect(report.score).toBe(20)
  })
})

// ── broadcast ─────────────────────────────────────────────────────────────────

describe('runVerification — verification_update broadcast', () => {
  it('emits a verification_update with the in-memory report', () => {
    const project = insertBareProject()
    const received: WsMessage[] = []
    const unsub = eventBus.onBroadcast(m => received.push(m))
    try {
      const report = runVerification(project)
      const msg = received.find(
        (m): m is Extract<WsMessage, { type: 'verification_update' }> =>
          m.type === 'verification_update' && m.report.id === report.id,
      )
      expect(msg).toBeDefined()
      // real arrays/objects, not the JSON-stringified DB form
      expect(Array.isArray(msg!.report.findings)).toBe(true)
      expect(msg!.report.breakdown).toEqual(report.breakdown)
    } finally {
      unsub()
    }
  })
})

// ── route 404 (light Fastify inject) ────────────────────────────────────────────

describe('verify/verifications routes — unknown id → 404', () => {
  it('POST /api/projects/:id/verify 404s for an unknown id', async () => {
    const app = Fastify()
    await app.register(projectsRoutes)
    const res = await app.inject({ method: 'POST', url: `/api/projects/${uuid()}/verify` })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/projects/:id/verifications 404s for an unknown id', async () => {
    const app = Fastify()
    await app.register(projectsRoutes)
    const res = await app.inject({ method: 'GET', url: `/api/projects/${uuid()}/verifications` })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

// ── CI-auditor scaffold idempotency (Task 8) ─────────────────────────────────────

describe('runVerification — CI-auditor scaffold is idempotent', () => {
  it('a second verify on a now-scaffolded project adds no new fix and drops the workflow critical', () => {
    const project = insertBareProject()

    // First run: no workflow → critical + scaffold.
    const first = runVerification(project)
    expect(first.fixesApplied).toEqual(['scaffolded CI workflow: .github/workflows/ci.yml'])
    const firstWorkflowCriticals = first.findings.filter(
      f => f.severity === 'critical' && /workflow/i.test(f.message),
    )
    expect(firstWorkflowCriticals).toHaveLength(1)

    // Second run: workflow now exists → scaffoldCi skips it (no new fix), and CI
    // is classified 'none' (workflow present but no runs) → info, NOT critical.
    const second = runVerification(project)
    expect(second.fixesApplied).toEqual([])
    const secondWorkflowCriticals = second.findings.filter(
      f => f.severity === 'critical' && /workflow/i.test(f.message),
    )
    expect(secondWorkflowCriticals).toHaveLength(0)
    const ciFinding = second.findings.find(f => f.area === 'ci')
    expect(ciFinding?.severity).toBe('info')
  })
})

// ── deep-verify dispatch (Task 8, light Fastify inject) ───────────────────────────

describe('POST /api/projects/:id/verify — deep dispatch', () => {
  beforeEach(() => startRunMock.mockClear())

  it('deep:true returns the deterministic report AND dispatches startRun', async () => {
    const project = insertBareProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/verify`,
        payload: { deep: true },
      })
      expect(res.statusCode).toBe(200)
      const report = res.json()
      expect(report.projectId).toBe(project.id)
      expect(typeof report.score).toBe('number')
      expect(startRunMock).toHaveBeenCalledTimes(1)
      const [, opts] = startRunMock.mock.calls[0]
      expect(opts).toMatchObject({ cwd: project.localPath, projectId: project.id })
    } finally {
      await app.close()
    }
  })

  it('no body (plain verify) returns the report and does NOT dispatch startRun', async () => {
    const project = insertBareProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/verify` })
      expect(res.statusCode).toBe(200)
      expect(res.json().projectId).toBe(project.id)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('deep:false returns the report and does NOT dispatch startRun', async () => {
    const project = insertBareProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/verify`,
        payload: { deep: false },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().projectId).toBe(project.id)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects a malformed body (non-boolean deep, or a JSON array) with 400', async () => {
    const project = insertBareProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      for (const payload of [{ deep: 'yes' }, [true] as unknown]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/verify`,
          payload,
        })
        expect(res.statusCode).toBe(400)
      }
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

// ── migration: score_breakdown column ────────────────────────────────────────────

describe('migrate() — verification_reports.score_breakdown', () => {
  const tmpPath = path.join(os.tmpdir(), `k-verify-migration-${Date.now()}.db`)
  // tempDb is created in the first `it` and reused by the second (ordered within
  // this describe); closed + unlinked in afterAll.
  let tempDb: Database.Database

  it('adds score_breakdown to an old-schema verification_reports table', () => {
    tempDb = new Database(tmpPath)
    // old schema: verification_reports WITHOUT score_breakdown
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE verification_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        findings TEXT NOT NULL DEFAULT '[]',
        fixes_applied TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)

    migrate(tempDb)

    const cols = tempDb.pragma('table_info(verification_reports)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('score_breakdown')
  })

  it('is idempotent — a second migrate() does not throw', () => {
    expect(() => migrate(tempDb)).not.toThrow()
  })

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })
})

// ── production db already has the column at boot ─────────────────────────────────

describe('db migration — verification_reports.score_breakdown (boot)', () => {
  it('score_breakdown column exists on the live db after boot migrate()', () => {
    const cols = db.pragma('table_info(verification_reports)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('score_breakdown')
  })
})

// ── migration: coverage_pct column (F4.W1) ───────────────────────────────────────

describe('migrate() — verification_reports.coverage_pct', () => {
  const tmpPath = path.join(os.tmpdir(), `k-verify-cov-migration-${Date.now()}.db`)
  // tempDb is created in the first `it` and reused by the second (ordered within
  // this describe); closed + unlinked in afterAll.
  let tempDb: Database.Database

  it('adds coverage_pct to an old-schema verification_reports table', () => {
    tempDb = new Database(tmpPath)
    // old schema: verification_reports WITHOUT coverage_pct (or score_breakdown)
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE verification_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        findings TEXT NOT NULL DEFAULT '[]',
        fixes_applied TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)

    migrate(tempDb)

    const cols = tempDb.pragma('table_info(verification_reports)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('coverage_pct')
  })

  it('is idempotent — a second migrate() does not throw', () => {
    expect(() => migrate(tempDb)).not.toThrow()
  })

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })
})

describe('db migration — verification_reports.coverage_pct (boot)', () => {
  it('coverage_pct column exists on the live db after boot migrate()', () => {
    const cols = db.pragma('table_info(verification_reports)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('coverage_pct')
  })
})
