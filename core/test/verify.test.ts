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
  bibleFreshnessDays,
  type HealthScoreInputs,
} from '../src/verify.js'

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

const ALL_GREEN: HealthScoreInputs = {
  ci: 'passing',
  coverageTrend: 'stable',
  bibleFresh: true,
  findings: [],
}

// ── computeHealthScore ──────────────────────────────────────────────────────

describe('computeHealthScore', () => {
  it('all-green = 100 with full breakdown', () => {
    const { score, breakdown } = computeHealthScore(ALL_GREEN)
    expect(score).toBe(100)
    expect(breakdown).toEqual({ ci: 40, coverage: 20, bible: 20, findings: 20 })
  })

  it('ci failing floors CI component to 0 → score caps at 60', () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'failing' })
    expect(breakdown.ci).toBe(0)
    expect(score).toBe(60)
  })

  it("ci 'none' scores 0 (same as failing)", () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'none' })
    expect(breakdown.ci).toBe(0)
    expect(score).toBe(60)
  })

  it('flaky ci = half component (20)', () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, ci: 'flaky' })
    expect(breakdown.ci).toBe(20)
    expect(score).toBe(80)
  })

  it('each open critical -10, warn -2 on findings component', () => {
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
    expect(score).toBe(80) // 40 + 20 + 20 + 0
  })

  it('info findings carry no penalty', () => {
    const { breakdown } = computeHealthScore({
      ...ALL_GREEN,
      findings: [finding('info'), finding('info')],
    })
    expect(breakdown.findings).toBe(20)
  })

  it("coverage 'unknown' is neutral — same score as stable", () => {
    const unknown = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'unknown' })
    const stable = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'stable' })
    expect(unknown.score).toBe(stable.score)
    expect(unknown.breakdown.coverage).toBe(20)
  })

  it("coverage 'improving' = full component (20)", () => {
    const { breakdown } = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'improving' })
    expect(breakdown.coverage).toBe(20)
  })

  it("coverage 'declining' = half component (10)", () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, coverageTrend: 'declining' })
    expect(breakdown.coverage).toBe(10)
    expect(score).toBe(90)
  })

  it('bibleFresh false → bible component 0', () => {
    const { score, breakdown } = computeHealthScore({ ...ALL_GREEN, bibleFresh: false })
    expect(breakdown.bible).toBe(0)
    expect(score).toBe(80)
  })

  it('floor case (declining coverage is the only non-zero component) → 10', () => {
    // ci=0, coverage=10 (declining=0.5·20), bible=0, findings floored to 0.
    // 'declining' is the lowest coverage multiplier, so this is the practical
    // minimum — there is no coverage input that scores 0.
    const { score, breakdown } = computeHealthScore({
      ci: 'failing',
      coverageTrend: 'declining',
      bibleFresh: false,
      findings: [finding('critical'), finding('critical')],
    })
    expect(breakdown).toEqual({ ci: 0, coverage: 10, bible: 0, findings: 0 })
    expect(score).toBe(10)
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

  it('null freshness → warn', () => {
    const f = auditBible(null, true)
    expect(f[0].severity).toBe('warn')
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
