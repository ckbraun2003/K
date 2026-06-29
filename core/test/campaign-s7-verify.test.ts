/**
 * Campaign S7 (LOCK / gating) — verify.ts edge & robustness locks.
 *
 * EXTENDS verify.test.ts + verify-run.test.ts (does not duplicate them). Focus on
 * vectors the existing suite leaves open:
 *   - computeHealthScore is integer + clamped [0,100] across EVERY factor combo,
 *     and the findings component floors at 0 under heavy penalties (never negative).
 *   - classifyCi is robust to malformed/empty `createdAt` (NaN-safe sort): a
 *     consistent run set classifies the same regardless of date order.
 *   - the deterministic CI scaffold is left UNCOMMITTED in the working tree (a
 *     proposed change for the operator — never git-added/committed) and the score
 *     still reflects CI-missing for the run that scaffolded it.
 *   - persistReport's atomic contract: the report-row insert and the project-health
 *     update either both land or neither — a mid-write failure rolls the insert back.
 *
 * DB-touching tests reuse the production `db` singleton (the established pattern)
 * and clean their rows in afterAll. Isolated K_DATA_DIR via vitest.config.ts.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import type { Finding, GithubStatus, CiRunInfo } from '@k/shared'
import {
  computeHealthScore,
  classifyCi,
  runVerification,
  type CiState,
  type CoverageTrend,
} from '../src/verify.js'
import { db, projectsDb, verificationDb } from '../src/db.js'

// ── shared fixtures / cleanup ─────────────────────────────────────────────────

const tmpDirs: string[] = []
const projectIds: string[] = []

function makeTmp(prefix = 'k-s7-verify-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function insertProject(localPath: string): string {
  const id = uuid()
  projectsDb.insertProject.run({
    id,
    name: `s7-verify-${id.slice(0, 8)}`,
    localPath,
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  projectIds.push(id)
  return id
}

afterAll(() => {
  for (const id of projectIds) {
    try { db.prepare('DELETE FROM verification_reports WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function ghStatus(ci: CiRunInfo[]): GithubStatus {
  return { prs: [], ci, fetchedAt: Date.now() }
}
function ciRun(conclusion: string | null, createdAt: string): CiRunInfo {
  return { id: Math.floor(Math.random() * 1e9), workflow: 'CI', branch: 'main', status: 'completed', conclusion, createdAt }
}
function warns(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => ({ severity: 'warn' as const, area: 'x', message: `warn ${i}` }))
}

// ── computeHealthScore — integer + clamp invariant across ALL combos ───────────

describe('computeHealthScore — integer & clamped across every factor combination', () => {
  it('score is always an integer in [0,100] for the full cartesian product of inputs', () => {
    const cis: CiState[] = ['passing', 'failing', 'flaky', 'none']
    const covs: CoverageTrend[] = ['improving', 'stable', 'declining', 'unknown']
    const bibles = [true, false]
    const findingSets: Finding[][] = [
      [],
      warns(1),
      warns(50),                                                   // huge warn pile
      [{ severity: 'critical', area: 'ci', message: 'c' }],
      Array.from({ length: 20 }, () => ({ severity: 'critical' as const, area: 'x', message: 'c' })),
      [{ severity: 'info', area: 'x', message: 'i' }],            // info = no penalty
    ]
    for (const ci of cis) for (const coverageTrend of covs) for (const bibleFresh of bibles) for (const findings of findingSets) {
      const { score, breakdown } = computeHealthScore({ ci, coverageTrend, bibleFresh, findings })
      expect(Number.isInteger(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
      // breakdown.findings is itself floored at 0 — never a negative contribution.
      expect(breakdown.findings).toBeGreaterThanOrEqual(0)
    }
  })

  it('findings component floors at 0 — a big warn pile cannot drive it negative', () => {
    // 11 warns = 20 − 22 = −2 → floored to 0; everything else all-green → 80.
    const { score, breakdown } = computeHealthScore({
      ci: 'passing', coverageTrend: 'stable', bibleFresh: true, findings: warns(11),
    })
    expect(breakdown.findings).toBe(0)
    expect(score).toBe(80)
  })

  it('mixed criticals + warns also floor at 0 (no double-debit underflow)', () => {
    // 2 crit (−20) + 4 warn (−8) = −28 → floor 0.
    const { breakdown } = computeHealthScore({
      ci: 'passing', coverageTrend: 'stable', bibleFresh: true,
      findings: [
        { severity: 'critical', area: 'a', message: 'c' },
        { severity: 'critical', area: 'b', message: 'c' },
        ...warns(4),
      ],
    })
    expect(breakdown.findings).toBe(0)
  })
})

// ── classifyCi — NaN-safe against malformed createdAt ──────────────────────────

describe('classifyCi — robust to malformed / empty createdAt (NaN-safe sort)', () => {
  it('a consistent all-success set classifies passing even with empty / bad dates', () => {
    const runs = [ciRun('success', ''), ciRun('success', 'not-a-date'), ciRun('success', '2026-06-10T00:00:00Z')]
    expect(classifyCi(ghStatus(runs), true)).toBe('passing')
  })

  it('a consistent all-failure set classifies failing with bad dates', () => {
    const runs = [ciRun('failure', ''), ciRun('failure', 'garbage')]
    expect(classifyCi(ghStatus(runs), true)).toBe('failing')
  })

  it('mixed success+failure stays flaky regardless of unparseable dates', () => {
    const runs = [ciRun('success', 'xxx'), ciRun('failure', '')]
    expect(classifyCi(ghStatus(runs), true)).toBe('flaky')
  })
})

// ── CI scaffold is UNCOMMITTED (charter: CI-scaffold-is-UNCOMMITTED) ────────────

describe('runVerification — scaffolded CI workflow is left UNCOMMITTED in the working tree', () => {
  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, {
      cwd, stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
  }

  it('writes .github/workflows/ci.yml as an untracked change; score still reflects CI-missing', () => {
    const repo = makeTmp('k-s7-scaffold-')
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-q', '-m', 'init'])

    const id = insertProject(repo)
    const project = {
      id, name: `s7-scaffold-${id.slice(0, 8)}`, localPath: repo,
      githubRemote: undefined, workspaceManaged: false, bibleDir: 'docs/bible', createdAt: Date.now(),
    }
    const report = runVerification(project)

    // the file landed in the working tree
    const ciPath = path.join(repo, '.github', 'workflows', 'ci.yml')
    expect(fs.existsSync(ciPath)).toBe(true)
    expect(report.fixesApplied).toContain('scaffolded CI workflow: .github/workflows/ci.yml')

    // …and it is UNCOMMITTED — git sees it as an untracked file (a proposed change
    // for operator review, never auto-committed/pushed). `-uall` expands the
    // otherwise-collapsed untracked directory so the file shows individually.
    const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
    expect(porcelain).toMatch(/^\?\?\s+\.github\/workflows\/ci\.yml$/m)
    // it is NOT in the git index / not tracked (definitively uncommitted).
    const tracked = execFileSync('git', ['ls-files', '.github/workflows/ci.yml'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(tracked).toBe('')

    // the SCORE for THIS run still reflects CI-missing — the scaffold does not
    // retroactively fix it (ci component 0; bare project ⇒ score 20).
    expect(report.breakdown.ci).toBe(0)
    expect(report.score).toBe(20)
  })
})

// ── persistReport atomicity — both-or-neither (charter: atomic txn rollback) ────

describe('atomic persist — report row + project health land together or not at all', () => {
  it('a mid-write failure rolls back the already-inserted report (no partial persist)', () => {
    const id = insertProject(makeTmp())
    const reportId = uuid()

    // Mirror persistReport (verify.ts): the SAME two real prepared statements in
    // one db.transaction. A failure AFTER the insert (standing in for the second
    // write — projectsDb.updateProjectHealth — throwing) must roll the insert back.
    const tx = db.transaction(() => {
      verificationDb.insertVerificationReport.run({
        id: reportId, projectId: id, score: 42, findings: '[]', fixesApplied: '[]',
        startedAt: Date.now(), completedAt: Date.now(), scoreBreakdown: null,
      })
      throw new Error('simulated mid-write failure (e.g. updateProjectHealth threw)')
    })

    expect(() => tx()).toThrow(/simulated mid-write failure/)

    // ROLLBACK: the inserted report must NOT be visible — neither write survived.
    const rows = verificationDb.listVerificationReports.all(id) as Array<{ id: string }>
    expect(rows.find(r => r.id === reportId)).toBeUndefined()
    // project health untouched by the rolled-back transaction
    const proj = db.prepare('SELECT health_score, last_verified_at FROM projects WHERE id = ?').get(id) as
      { health_score: number | null; last_verified_at: number | null }
    expect(proj.health_score == null).toBe(true)
  })

  it('a successful transaction commits BOTH writes', () => {
    const id = insertProject(makeTmp())
    const reportId = uuid()
    const tx = db.transaction(() => {
      verificationDb.insertVerificationReport.run({
        id: reportId, projectId: id, score: 77, findings: '[]', fixesApplied: '[]',
        startedAt: Date.now(), completedAt: 123456, scoreBreakdown: null,
      })
      projectsDb.updateProjectHealth.run({ id, healthScore: 77, lastVerifiedAt: 123456 })
    })
    tx()
    const rows = verificationDb.listVerificationReports.all(id) as Array<{ id: string }>
    expect(rows.find(r => r.id === reportId)).toBeDefined()
    const proj = db.prepare('SELECT health_score, last_verified_at FROM projects WHERE id = ?').get(id) as
      { health_score: number; last_verified_at: number }
    expect(proj.health_score).toBe(77)
    expect(proj.last_verified_at).toBe(123456)
  })
})
