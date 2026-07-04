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
import { db, projectsDb, verificationDb, rowToReport, migrate, SCHEMA_VERSION } from '../src/db.js'
import { runVerification } from '../src/verify.js'
import { getProject } from '../src/projects.js'
import { scaffoldCi, BIBLE_SCAFFOLD_MARKER } from '../src/scaffold.js'
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
    // A bare project (no decisive CI run, no coverage, no authored bible) has NO
    // measured dimension → the score is NULL (insufficient signal), NOT an inflated
    // number, and the scaffold does not retroactively supply a real CI signal.
    expect(report.breakdown.ci).toBeNull()
    expect(report.score).toBeNull()

    // project health null (undefined once read back — health_score NULL) + last_verified_at set
    const updated = getProject(project.id)
    expect(updated?.healthScore).toBeUndefined()
    expect(persisted.score).toBeNull() // null round-trips through the nullable column
    expect(updated?.lastVerifiedAt).toBe(report.completedAt)

    // breakdown round-trips through the DB — every dimension unmeasured (null) for a
    // bare project (no CI runs, coverage unknown, no authored bible).
    expect(report.breakdown).toEqual({ ci: null, coverage: null, bible: null, findings: null })
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
    // With a MEASURED coverage signal present (below), the score is non-null and the
    // coverage decline is the varying factor: CI stays unmeasured (no decisive run) and
    // bible unmeasured (no bible) across both runs, so only coverage moves the score.

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

    // three criticals (no-workflow, no-bible, no-remote), no warns/info. The FINDINGS
    // dedupe contract above is unchanged; the SCORE is null because a bare project has
    // no measured dimension (CI never ran, no coverage, bible not authored) — the
    // criticals are surfaced as the actionable list, not folded into an inflated number.
    const criticals = report.findings.filter(f => f.severity === 'critical')
    expect(criticals).toHaveLength(3)
    expect(report.breakdown).toEqual({ ci: null, coverage: null, bible: null, findings: null })
    expect(report.score).toBeNull()
  })
})

// ── F-032 rework: no scaffold inflation; authored bible is measured ──────────────

describe('runVerification — prorate over MEASURED dims (no scaffold inflation)', () => {
  // Write a bible under the project's actual bibleDir. `authored:false` keeps the
  // onboarding scaffold marker in every section (a bare scaffold); `authored:true`
  // drops it (real content).
  function writeBible(project: Project, authored: boolean): void {
    const parts = project.bibleDir.split(/[\\/]/)
    const root = path.join(project.localPath, ...parts)
    fs.mkdirSync(path.join(root, 'sections'), { recursive: true })
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ sections: ['01-vision'] }))
    const body = authored
      ? 'Our genuine, hand-authored vision.'
      : `> ${BIBLE_SCAFFOLD_MARKER}. Replace with your project's real content.`
    fs.writeFileSync(path.join(root, 'sections', '01-vision.md'), `---\ntitle: "Vision"\n---\n\n${body}\n`)
  }

  it('a scaffold-only project verifies to NULL both times — a never-run CI scaffold earns no credit', () => {
    const project = insertBareProject()
    // Onboard-equivalent: a CI workflow FILE (never run) + a bare SCAFFOLD bible.
    scaffoldCi(project.localPath)
    writeBible(project, false)

    const first = runVerification(project)
    // The workflow exists but has NEVER produced a decisive run → ci UNMEASURED
    // (excluded), NOT credited. The scaffold bible is not authored → unmeasured. No
    // coverage. ⇒ nothing measured ⇒ score null.
    expect(first.breakdown.ci).toBeNull()
    expect(first.breakdown.bible).toBeNull()
    expect(first.score).toBeNull()

    // Second verify: still no CI runs, still a scaffold bible ⇒ still null. The
    // never-run scaffold never turns into CI credit.
    const second = runVerification(project)
    expect(second.breakdown.ci).toBeNull()
    expect(second.score).toBeNull()
  })

  it('AUTHORING a bible section makes the bible dimension MEASURED → a non-null score', () => {
    const project = insertBareProject()
    writeBible(project, true) // real content (no scaffold marker)

    const report = runVerification(project)
    expect(report.breakdown.bible).toBe(20) // authored → measured full
    expect(report.score).not.toBeNull()     // at least one dimension measured
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
      // score is a number OR null (insufficient signal for a bare project — F-032 rework)
      expect(report.score === null || typeof report.score === 'number').toBe(true)
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

// ── F-033 server guard: onboard/verify refuse a missing localPath ─────────────────

describe('onboard/verify routes — 409 when the project localPath is missing on disk', () => {
  /** Insert a project pointing at a path that does NOT exist. */
  function insertMissingPathProject(): string {
    const id = uuid()
    projectsDb.insertProject.run({
      id,
      name: `verify-missing-${id.slice(0, 8)}`,
      localPath: path.join(os.tmpdir(), `k-gone-${id}`), // never created
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'artifacts/bible',
      createdAt: Date.now(),
    })
    projectIds.push(id)
    return id
  }

  it('POST /onboard 409s for a missing path and does NOT recreate the directory', async () => {
    const id = insertMissingPathProject()
    const missingPath = getProject(id)!.localPath
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/onboard` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/missing on disk/i)
      // the guard fired BEFORE any scaffold write — the dir was not mkdir-recreated.
      expect(fs.existsSync(missingPath)).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('POST /verify 409s for a missing path (no work done)', async () => {
    const id = insertMissingPathProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/verify` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/missing on disk/i)
    } finally {
      await app.close()
    }
  })

  it('both routes still work when the path EXISTS', async () => {
    const project = insertBareProject() // real temp dir
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const onboard = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/onboard` })
      expect(onboard.statusCode).toBe(200)
      const verify = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/verify` })
      expect(verify.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

// ── migration: verification_reports.score NOT NULL → nullable (F-032 rework) ───────

describe('migrate() — verification_reports.score becomes nullable', () => {
  const tmpPath = path.join(os.tmpdir(), `k-verify-scorenull-${Date.now()}.db`)
  let tempDb: Database.Database

  afterAll(() => {
    try { tempDb?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('rebuilds an old NOT-NULL score column to nullable; a null score can then be inserted; rows preserved', () => {
    tempDb = new Database(tmpPath)
    tempDb.pragma('foreign_keys = ON')
    // Old schema: score INTEGER NOT NULL (+ the columns migrate() adds before the rebuild).
    tempDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT, cwd TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE verification_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        score INTEGER NOT NULL,
        findings TEXT NOT NULL DEFAULT '[]',
        fixes_applied TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)
    tempDb.prepare(`INSERT INTO projects (id) VALUES ('p1')`).run()
    tempDb.prepare(
      `INSERT INTO verification_reports (id, project_id, score, started_at) VALUES ('r-old', 'p1', 88, 1000)`,
    ).run()

    migrate(tempDb)

    // (a) the score column is now nullable
    const scoreCol = (tempDb.pragma('table_info(verification_reports)') as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'score')
    expect(scoreCol?.notnull).toBe(0)

    // (b) the pre-existing row survived intact
    const old = tempDb.prepare(`SELECT score FROM verification_reports WHERE id = 'r-old'`).get() as { score: number }
    expect(old.score).toBe(88)

    // (c) a NULL score now inserts (insufficient-signal report)
    expect(() =>
      tempDb.prepare(
        `INSERT INTO verification_reports (id, project_id, score, started_at) VALUES ('r-null', 'p1', NULL, 2000)`,
      ).run(),
    ).not.toThrow()
    const nul = tempDb.prepare(`SELECT score FROM verification_reports WHERE id = 'r-null'`).get() as { score: number | null }
    expect(nul.score).toBeNull()

    expect(tempDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('is idempotent — a second full scan does not rebuild again or throw', () => {
    tempDb.pragma('user_version = 0')
    expect(() => migrate(tempDb)).not.toThrow()
    const scoreCol = (tempDb.pragma('table_info(verification_reports)') as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'score')
    expect(scoreCol?.notnull).toBe(0)
  })
})

describe('db migration — verification_reports.score nullable (boot)', () => {
  it('the live db score column is nullable after boot migrate()', () => {
    const scoreCol = (db.pragma('table_info(verification_reports)') as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'score')
    expect(scoreCol?.notnull).toBe(0)
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
    // Force the FULL scan — the user_version fast path would otherwise skip the
    // guarded-ALTER branch this case re-runs.
    tempDb.pragma('user_version = 0')
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
    // Force the FULL scan (see the score_breakdown twin above).
    tempDb.pragma('user_version = 0')
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
