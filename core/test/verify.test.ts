import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'node:child_process'
import type { Finding, Project, GithubStatus, CiRunInfo } from '@k/shared'
import {
  computeHealthScore,
  classifyCi,
  auditCi,
  auditBible,
  bibleFreshFromDays,
  auditInvariants,
  hasWorkflowFile,
  hasBibleDir,
  hasAuthoredBible,
  bibleFreshnessDays,
  readCoveragePct,
  classifyCoverageTrend,
  type HealthScoreInputs,
} from '../src/verify.js'
import { scaffoldBible, BIBLE_SCAFFOLD_MARKER } from '../src/scaffold.js'

// ── fixtures ────────────────────────────────────────────────────────────────

function finding(severity: Finding['severity'], area = 'x'): Finding {
  return { severity, area, message: `${severity} ${area}` }
}

function ghStatus(ci: CiRunInfo[]): GithubStatus {
  return { prs: [], ci, fetchedAt: Date.now() }
}

let runSeq = 0
// Default createdAt is derived as a fixed base epoch + runSeq seconds so each
// auto-generated run gets a distinct, always-valid ISO timestamp (newer = later
// runSeq). Avoids the day-of-month overflow a `2026-06-${10+runSeq}` form hits
// once runSeq exceeds 21.
const RUN_BASE_MS = Date.parse('2026-06-10T12:00:00Z')
function ciRun(conclusion: string | null, createdAt?: string): CiRunInfo {
  const seq = ++runSeq
  return {
    id: seq,
    workflow: 'CI',
    branch: 'main',
    status: conclusion == null ? 'in_progress' : 'completed',
    conclusion,
    createdAt: createdAt ?? new Date(RUN_BASE_MS + seq * 1000).toISOString(),
  }
}

// A fully-MEASURED, healthy project: real passing CI, measured stable coverage, an
// authored bible, no findings. Every dimension is measured → the score is the plain
// weighted sum, 100.
const ALL_GREEN: HealthScoreInputs = {
  ci: 'passing',
  coverageTrend: 'stable',
  bibleAuthored: true,
  findings: [],
}

// ── computeHealthScore (F-032 rework: PRORATE over MEASURED dimensions) ────────

describe('computeHealthScore', () => {
  it('all-measured green = 100 with full breakdown', () => {
    const { score, breakdown } = computeHealthScore(ALL_GREEN)
    expect(score).toBe(100)
    expect(breakdown).toEqual({ ci: 40, coverage: 20, bible: 20, findings: 20 })
  })

  it('CRUX: an all-UNMEASURED project (scaffold, nothing run) scores NULL, not 100', () => {
    // ci 'none' (no decisive run — a scaffold workflow that never ran), coverage
    // 'unknown' (no summary), bible NOT authored (bare scaffold). Nothing is
    // measurable → insufficient signal → null, and every breakdown cell is null.
    const { score, breakdown } = computeHealthScore({
      ci: 'none',
      coverageTrend: 'unknown',
      bibleAuthored: false,
      findings: [],
    })
    expect(score).toBeNull()
    expect(breakdown).toEqual({ ci: null, coverage: null, bible: null, findings: null })
  })

  it("ci 'none' (no decisive run) is EXCLUDED, not zeroed — score prorates over the rest", () => {
    // ci null/excluded; coverage 20 + bible 20 + findings 20 over weight 60 → 100.
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'none' })
    expect(breakdown.ci).toBeNull()
    expect(score).toBe(100)
  })

  it('ci failing is a MEASURED problem → 0/40, dragged into the prorate', () => {
    // ci 0 + coverage 20 + bible 20 + findings 20 over weight 100 → 60.
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'failing' })
    expect(breakdown.ci).toBe(0)
    expect(score).toBe(60)
  })

  it('flaky ci = MEASURED half (20/40)', () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'flaky' })
    expect(breakdown.ci).toBe(20)
    expect(score).toBe(80) // (20+20+20+20)/100
  })

  it('each open critical -10, warn -2 on the findings component', () => {
    const { breakdown } = computeHealthScore({
      ...ALL_GREEN,
      findings: [finding('critical'), finding('warn'), finding('warn')],
    })
    expect(breakdown.findings).toBe(20 - 10 - 2 - 2) // 6
  })

  it('findings component floors at 0 (3 criticals → 0, not negative)', () => {
    const { score, breakdown } = computeHealthScore({
      ...ALL_GREEN,
      findings: [finding('critical'), finding('critical'), finding('critical')],
    })
    expect(breakdown.findings).toBe(0)
    expect(score).toBe(80) // (40+20+20+0)/100
  })

  it('info findings carry no penalty', () => {
    const { breakdown } = computeHealthScore({
      ...ALL_GREEN,
      findings: [finding('info'), finding('info')],
    })
    expect(breakdown.findings).toBe(20)
  })

  it("coverage 'unknown' is EXCLUDED (no summary) — null, not credited full", () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'unknown' })
    expect(breakdown.coverage).toBeNull()
    // ci 40 + bible 20 + findings 20 over weight 80 → 100.
    expect(score).toBe(100)
  })

  it("coverage 'improving' = MEASURED full (20)", () => {
    const { breakdown } = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'improving' })
    expect(breakdown.coverage).toBe(20)
  })

  it("coverage 'declining' = MEASURED half (10)", () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'declining' })
    expect(breakdown.coverage).toBe(10)
    expect(score).toBe(90) // (40+10+20+20)/100
  })

  it('an UNAUTHORED (scaffold) bible is EXCLUDED — bible null, prorated over the rest', () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, bibleAuthored: false })
    expect(breakdown.bible).toBeNull()
    // ci 40 + coverage 20 + findings 20 over weight 80 → 100.
    expect(score).toBe(100)
  })

  it('an AUTHORED bible is MEASURED full (20) regardless of commits (F-032b)', () => {
    const { breakdown } = computeHealthScore({ ...ALL_GREEN, bibleAuthored: true })
    expect(breakdown.bible).toBe(20)
  })

  it('findings dimension is EXCLUDED when there is NO other signal (stays null → score null)', () => {
    // Even with a clean findings set, a zero-signal project is null (not 100): the
    // findings quality only counts once ci/coverage/bible has real signal.
    const { score, breakdown } = computeHealthScore({
      ci: 'none',
      coverageTrend: 'unknown',
      bibleAuthored: false,
      findings: [finding('info')],
    })
    expect(score).toBeNull()
    expect(breakdown.findings).toBeNull()
  })

  it('prorate example: failing CI + declining coverage + criticals, no bible', () => {
    // ci 0/40 (measured), coverage 10/20 (measured), bible null (unauthored), findings
    // measured (signal present) → 2 criticals floor findings to 0/20. earned 10 over
    // weight 80 → round(12.5) = 13.
    const { score, breakdown } = computeHealthScore({
      ci: 'failing',
      coverageTrend: 'declining',
      bibleAuthored: false,
      findings: [finding('critical'), finding('critical')],
    })
    expect(breakdown).toEqual({ ci: 0, coverage: 10, bible: null, findings: 0 })
    expect(score).toBe(13)
  })
})

// ── classifyCoverageTrend (pure) ──────────────────────────────────────────────

describe('classifyCoverageTrend', () => {
  it("current null → 'unknown' (no signal, stays neutral)", () => {
    expect(classifyCoverageTrend(null, 80)).toBe('unknown')
    expect(classifyCoverageTrend(null, null)).toBe('unknown')
  })

  it("prior null + current present → 'stable' (first real reading)", () => {
    expect(classifyCoverageTrend(90, null)).toBe('stable')
  })

  it("clear rise → 'improving'", () => {
    expect(classifyCoverageTrend(90, 80)).toBe('improving')
  })

  it("equal / within tol → 'stable'", () => {
    expect(classifyCoverageTrend(87.5, 87.5)).toBe('stable')
    expect(classifyCoverageTrend(87.5, 87.55)).toBe('stable')
  })

  it("clear drop → 'declining'", () => {
    expect(classifyCoverageTrend(80, 87.5)).toBe('declining')
  })

  it('tol boundary: drop of exactly 0.1 → stable, drop of 0.2 → declining', () => {
    expect(classifyCoverageTrend(87.5, 87.6)).toBe('stable') // drop 0.1 == tol
    expect(classifyCoverageTrend(87.5, 87.7)).toBe('declining') // drop 0.2 > tol
  })
})

// ── classifyCi ──────────────────────────────────────────────────────────────

describe('classifyCi', () => {
  it("no workflow → 'none'", () => {
    expect(classifyCi(ghStatus([ciRun('success')]), false)).toBe('none')
  })

  it("workflow but no completed runs → 'none'", () => {
    expect(classifyCi(ghStatus([ciRun(null)]), true)).toBe('none')
    expect(classifyCi(ghStatus([]), true)).toBe('none')
  })

  it('mix of older success + newer failure → flaky (not failing)', () => {
    const runs = [
      ciRun('success', '2026-06-01T00:00:00Z'),
      ciRun('failure', '2026-06-10T00:00:00Z'), // newest
    ]
    // both success+failure observed → flaky, regardless of which is newest
    expect(classifyCi(ghStatus(runs), true)).toBe('flaky')
  })

  it("only failures → 'failing'", () => {
    const runs = [
      ciRun('failure', '2026-06-01T00:00:00Z'),
      ciRun('failure', '2026-06-10T00:00:00Z'),
    ]
    expect(classifyCi(ghStatus(runs), true)).toBe('failing')
  })

  it("mixed conclusions → 'flaky'", () => {
    const runs = [ciRun('success'), ciRun('failure'), ciRun('success')]
    expect(classifyCi(ghStatus(runs), true)).toBe('flaky')
  })

  it("all success → 'passing'", () => {
    const runs = [ciRun('success'), ciRun('success')]
    expect(classifyCi(ghStatus(runs), true)).toBe('passing')
  })

  it('ignores in-progress runs (conclusion null)', () => {
    const runs = [ciRun('success'), ciRun(null)]
    expect(classifyCi(ghStatus(runs), true)).toBe('passing')
  })

  it("ignores neutral conclusions — success + cancelled stays 'passing' (not flaky)", () => {
    const runs = [ciRun('success'), ciRun('cancelled'), ciRun('skipped')]
    expect(classifyCi(ghStatus(runs), true)).toBe('passing')
  })

  it("workflow with only neutral conclusions → 'none' (no decisive signal)", () => {
    const runs = [ciRun('skipped'), ciRun('cancelled')]
    expect(classifyCi(ghStatus(runs), true)).toBe('none')
  })

  it("decisive failure-class conclusions (timed_out) count as failure", () => {
    expect(classifyCi(ghStatus([ciRun('timed_out')]), true)).toBe('failing')
    expect(classifyCi(ghStatus([ciRun('success'), ciRun('timed_out')]), true)).toBe('flaky')
  })
})

// ── auditCi ─────────────────────────────────────────────────────────────────

describe('auditCi', () => {
  it('no workflow → critical', () => {
    const f = auditCi(ghStatus([]), false)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ severity: 'critical', area: 'ci' })
  })

  it('latest failure → critical', () => {
    const f = auditCi(ghStatus([ciRun('failure')]), true)
    expect(f[0].severity).toBe('critical')
  })

  it('flaky → warn', () => {
    const f = auditCi(ghStatus([ciRun('success'), ciRun('failure')]), true)
    expect(f[0].severity).toBe('warn')
  })

  it('passing → no finding', () => {
    expect(auditCi(ghStatus([ciRun('success')]), true)).toEqual([])
  })

  it('workflow but no runs → info', () => {
    const f = auditCi(ghStatus([]), true)
    expect(f[0].severity).toBe('info')
  })
})

// ── auditBible + bibleFreshFromDays ───────────────────────────────────────────

describe('auditBible', () => {
  it('no bible dir → critical', () => {
    const f = auditBible(5, false)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ severity: 'critical', area: 'bible' })
  })

  it('null freshness → info (unmeasurable, no penalty — F-032)', () => {
    // A present bible with no commit-based freshness signal is UNKNOWN, not stale:
    // info carries no findings penalty (onboarding leaves it uncommitted by design).
    const f = auditBible(null, true)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('info')
    expect(f[0].message).toContain('freshness unknown')
  })

  it('freshnessDays > 30 → warn (stale)', () => {
    const f = auditBible(45, true)
    expect(f[0].severity).toBe('warn')
    expect(f[0].message).toContain('45')
  })

  it('freshnessDays <= 30 → no finding', () => {
    expect(auditBible(30, true)).toEqual([])
    expect(auditBible(0, true)).toEqual([])
  })
})

describe('bibleFreshFromDays', () => {
  it('no bible dir → false', () => {
    expect(bibleFreshFromDays(5, false)).toBe(false)
  })
  it('null freshness → false', () => {
    expect(bibleFreshFromDays(null, true)).toBe(false)
  })
  it('<= 30 → true', () => {
    expect(bibleFreshFromDays(30, true)).toBe(true)
    expect(bibleFreshFromDays(0, true)).toBe(true)
  })
  it('> 30 → false', () => {
    expect(bibleFreshFromDays(31, true)).toBe(false)
  })
})

// ── temp dir helpers (mirror onboard.test.ts) ─────────────────────────────────

const tmps: string[] = []
function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-verify-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function makeProject(localPath: string, githubRemote?: string): Project {
  return {
    id: 'test-id',
    name: 'test-project',
    localPath,
    githubRemote,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
}

// ── auditInvariants ───────────────────────────────────────────────────────────

describe('auditInvariants (pure — takes gathered facts)', () => {
  const allPresent = { hasBible: true, hasWorkflow: true }

  it('missing githubRemote → critical', () => {
    const f = auditInvariants(makeProject('/x', undefined), allPresent)
    expect(f.some(x => x.area === 'invariants' && x.message.includes('GitHub remote'))).toBe(true)
  })

  it('present remote + bible + workflows → no findings', () => {
    const f = auditInvariants(makeProject('/x', 'owner/repo'), allPresent)
    expect(f).toEqual([])
  })

  it('present remote but both dirs missing → 2 critical invariant findings', () => {
    const f = auditInvariants(makeProject('/x', 'owner/repo'), { hasBible: false, hasWorkflow: false })
    expect(f).toHaveLength(2)
    expect(f.every(x => x.severity === 'critical' && x.area === 'invariants')).toBe(true)
  })

  it('does NOT touch the filesystem — bogus localPath with all-present facts yields no findings', () => {
    const f = auditInvariants(makeProject('/no/such/path/anywhere', 'owner/repo'), allPresent)
    expect(f).toEqual([])
  })

  // Wiring check: the FS helpers (Task 7 gathers these) compose with the pure auditor.
  it('composes with the fs helpers the orchestration uses', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, 'docs', 'bible'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'bible', 'manifest.json'), '{}')
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'name: CI\n')

    const project = makeProject(tmp, 'owner/repo')
    const facts = { hasBible: hasBibleDir(tmp, project.bibleDir), hasWorkflow: hasWorkflowFile(tmp) }
    expect(facts).toEqual({ hasBible: true, hasWorkflow: true })
    expect(auditInvariants(project, facts)).toEqual([])
  })
})

// ── fs/git helpers ────────────────────────────────────────────────────────────

describe('hasWorkflowFile', () => {
  it('false when .github/workflows absent', () => {
    expect(hasWorkflowFile(makeTmp())).toBe(false)
  })

  it('false when dir exists but holds no yml', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'readme.txt'), 'x')
    expect(hasWorkflowFile(tmp)).toBe(false)
  })

  it('true with a .yml file', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'name: CI\n')
    expect(hasWorkflowFile(tmp)).toBe(true)
  })

  it('true with a .yaml file (case-insensitive ext)', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'deploy.YAML'), 'name: D\n')
    expect(hasWorkflowFile(tmp)).toBe(true)
  })
})

describe('hasBibleDir', () => {
  it('false without manifest.json', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, 'docs', 'bible'), { recursive: true }) // empty dir
    expect(hasBibleDir(tmp, 'docs/bible')).toBe(false)
  })

  it('true with manifest.json sentinel', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, 'docs', 'bible'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'bible', 'manifest.json'), '{}')
    expect(hasBibleDir(tmp, 'docs/bible')).toBe(true)
  })
})

// ── hasAuthoredBible (authored-vs-scaffold — F-032 rework) ─────────────────────

describe('hasAuthoredBible', () => {
  it('false with no bible at all', () => {
    expect(hasAuthoredBible(makeTmp(), 'artifacts/bible')).toBe(false)
  })

  it('false for a PURE onboarding scaffold (every section still carries the marker)', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp) // writes the placeholder manifest + sections
    expect(hasBibleDir(tmp, 'artifacts/bible')).toBe(true) // manifest present…
    expect(hasAuthoredBible(tmp, 'artifacts/bible')).toBe(false) // …but nothing authored
  })

  it('true once ANY section is authored (its scaffold marker removed)', () => {
    const tmp = makeTmp()
    scaffoldBible(tmp)
    // Author one section: replace the placeholder body (drop the marker line).
    const sec = path.join(tmp, 'artifacts', 'bible', 'sections', '01-vision.md')
    fs.writeFileSync(sec, '---\ntitle: "Vision"\nicon: "◈"\nstatus: draft\nupdated: 2026-07-04\n---\n\nReal authored vision content.\n')
    expect(fs.readFileSync(sec, 'utf8').includes(BIBLE_SCAFFOLD_MARKER)).toBe(false)
    expect(hasAuthoredBible(tmp, 'artifacts/bible')).toBe(true)
  })

  it('true for a hand-authored bible whose sections never had the scaffold marker', () => {
    const tmp = makeTmp()
    const dir = path.join(tmp, 'artifacts', 'bible', 'sections')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'artifacts', 'bible', 'manifest.json'), JSON.stringify({ sections: ['intro'] }))
    fs.writeFileSync(path.join(dir, 'intro.md'), '# Intro\n\nGenuine content.\n')
    expect(hasAuthoredBible(tmp, 'artifacts/bible')).toBe(true)
  })

  it('false when a manifest exists but the sections dir is missing/empty', () => {
    const tmp = makeTmp()
    fs.mkdirSync(path.join(tmp, 'artifacts', 'bible'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'artifacts', 'bible', 'manifest.json'), '{}')
    expect(hasAuthoredBible(tmp, 'artifacts/bible')).toBe(false)
  })
})

describe('bibleFreshnessDays', () => {
  it('returns null when not a git repo (try/catch path)', () => {
    const tmp = makeTmp()
    expect(bibleFreshnessDays(tmp, 'docs/bible')).toBeNull()
  })

  it('returns null when the repo has no commit touching the bible dir', () => {
    const tmp = makeTmp()
    initRepo(tmp)
    commitFile(tmp, 'README.md', '# hi') // commit, but not under docs/bible
    expect(bibleFreshnessDays(tmp, 'docs/bible')).toBeNull()
  })

  it('counts whole days from the last bible commit (today → 0)', () => {
    const tmp = makeTmp()
    initRepo(tmp)
    commitFile(tmp, 'docs/bible/manifest.json', '{}')
    expect(bibleFreshnessDays(tmp, 'docs/bible')).toBe(0)
  })

  it('computes the day delta from a backdated commit (≈40 days → stale)', () => {
    const tmp = makeTmp()
    initRepo(tmp)
    const when = new Date(Date.now() - 40 * 86_400 * 1000).toISOString()
    commitFile(tmp, 'docs/bible/manifest.json', '{}', when)
    const days = bibleFreshnessDays(tmp, 'docs/bible')
    expect(days).not.toBeNull()
    // floor of (~40d minus a few ms of test runtime) → 39 or 40; either is "stale".
    expect(days).toBeGreaterThanOrEqual(39)
    expect(days).toBeLessThanOrEqual(40)
  })
})

// ── readCoveragePct ───────────────────────────────────────────────────────────

describe('readCoveragePct', () => {
  function writeSummary(tmp: string, json: string): void {
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-summary.json'), json)
  }

  it('reads total.lines.pct from a json-summary file', () => {
    const tmp = makeTmp()
    writeSummary(tmp, JSON.stringify({ total: { lines: { pct: 87.5 } } }))
    expect(readCoveragePct(tmp)).toBe(87.5)
  })

  it('null when the summary file is missing', () => {
    expect(readCoveragePct(makeTmp())).toBeNull()
  })

  it('null on garbled JSON', () => {
    const tmp = makeTmp()
    writeSummary(tmp, '{ not json')
    expect(readCoveragePct(tmp)).toBeNull()
  })

  it('null when pct is out of range (150 or -5)', () => {
    for (const pct of [150, -5]) {
      const tmp = makeTmp()
      writeSummary(tmp, JSON.stringify({ total: { lines: { pct } } }))
      expect(readCoveragePct(tmp)).toBeNull()
    }
  })

  it('null when total.lines.pct is missing / wrong-typed', () => {
    const tmp = makeTmp()
    writeSummary(tmp, JSON.stringify({ total: { statements: { pct: 50 } } }))
    expect(readCoveragePct(tmp)).toBeNull()

    const tmp2 = makeTmp()
    writeSummary(tmp2, JSON.stringify({ total: { lines: { pct: '90' } } }))
    expect(readCoveragePct(tmp2)).toBeNull()
  })
})

// ── git test helpers (local temp repos) ───────────────────────────────────────

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...env } })
}
function initRepo(cwd: string): void {
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
}
function commitFile(cwd: string, rel: string, content: string, isoDate?: string): void {
  const abs = path.join(cwd, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  git(cwd, ['add', rel])
  const env = isoDate ? { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : undefined
  git(cwd, ['commit', '-q', '-m', `add ${rel}`], env)
}
