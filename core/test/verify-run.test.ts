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
import { describe, it, expect, afterAll, afterEach } from 'vitest'
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
    expect(persisted.fixesApplied).toEqual([])

    // project health + last_verified_at were updated
    const updated = getProject(project.id)
    expect(updated?.healthScore).toBe(report.score)
    expect(updated?.lastVerifiedAt).toBe(report.completedAt)

    // breakdown round-trips: the four persisted components equal the in-memory ones
    expect(persisted.breakdown).toBeDefined()
    expect(persisted.breakdown).toEqual(report.breakdown)
    expect(report.breakdown).toEqual({
      ci: report.breakdown!.ci,
      coverage: report.breakdown!.coverage,
      bible: report.breakdown!.bible,
      findings: report.breakdown!.findings,
    })
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

// ── migration: score_breakdown column ────────────────────────────────────────────

describe('migrate() — verification_reports.score_breakdown', () => {
  const tmpPath = path.join(os.tmpdir(), `k-verify-migration-${Date.now()}.db`)
  let tempDb: Database.Database

  afterEach(() => { /* keep tempDb open across the two ordered its */ })

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
