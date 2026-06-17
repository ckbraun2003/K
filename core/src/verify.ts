/**
 * Verification engine — bible §5 health-score formula + auditors.
 *
 * The PURE, I/O-free core lives at the top: computeHealthScore + the auditor
 * functions all take already-gathered facts and return values. None of them
 * touch the filesystem or git. The thin FS/git fact-gatherers at the BOTTOM
 * are the only impure code; Task 7's orchestration calls those to assemble the
 * facts, then feeds them into the pure functions.
 *
 * No DB calls here. No agent calls. Synchronous by design — verification runs
 * are deterministic single-shot snapshots.
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'node:child_process'
import type { Finding, Project, GithubStatus, CiRunInfo } from '@k/shared'

// ─── Health score (pure, bible §5) ───────────────────────────────────────────

export type CiState = 'passing' | 'failing' | 'flaky' | 'none'
export type CoverageTrend = 'improving' | 'stable' | 'declining' | 'unknown'

export interface HealthScoreInputs {
  ci: CiState
  coverageTrend: CoverageTrend
  bibleFresh: boolean
  findings: Finding[]
}

/** Per-factor point values, each already multiplied by its weight.
 *  ci ∈ {0,20,40}; coverage/bible ∈ {0,10,20}; findings ∈ [0,20] integer. */
export interface HealthBreakdown {
  ci: number
  coverage: number
  bible: number
  findings: number
}

export interface HealthScore {
  score: number          // rounded integer, clamped [0,100]
  breakdown: HealthBreakdown
}

// Bible §5 weights.
const W_CI = 40
const W_COVERAGE = 20
const W_BIBLE = 20
const W_FINDINGS = 20

// Open-finding penalties applied against the findings component.
const PENALTY_CRITICAL = 10
const PENALTY_WARN = 2

/** CI factor multiplier (0..1). `none` scores 0 — a project with no CI workflow
 *  gets no CI credit, same as failing. `flaky` gets half. */
function ciFactor(ci: CiState): number {
  switch (ci) {
    case 'passing': return 1
    case 'flaky': return 0.5
    case 'failing': return 0
    case 'none': return 0
  }
}

/** Coverage factor multiplier (0..1). `unknown` is the neutral default (1) — we
 *  do NOT penalize until a real coverage signal exists (plan risk #1). `stable`
 *  (≥ baseline) is full; `declining` gets partial credit (0.5). */
function coverageFactor(trend: CoverageTrend): number {
  switch (trend) {
    case 'improving': return 1
    case 'stable': return 1
    case 'unknown': return 1
    case 'declining': return 0.5
  }
}

/** Findings component points: start at full weight, subtract per OPEN finding,
 *  floor at 0. info findings carry no penalty. */
function findingsPoints(findings: Finding[]): number {
  let points = W_FINDINGS
  for (const f of findings) {
    if (f.severity === 'critical') points -= PENALTY_CRITICAL
    else if (f.severity === 'warn') points -= PENALTY_WARN
  }
  return Math.max(0, points)
}

/**
 * Pure bible §5 health score:
 *   score = 40·CI + 20·coverageTrend + 20·bibleFreshness + 20·findings
 * where each factor is a 0..1 multiplier of its weight (findings is computed
 * directly in points). Returns the rounded clamped score plus the per-factor
 * breakdown (exact, unrounded multiples of the weights) for the UI bars.
 */
export function computeHealthScore(inputs: HealthScoreInputs): HealthScore {
  const ci = W_CI * ciFactor(inputs.ci)
  const coverage = W_COVERAGE * coverageFactor(inputs.coverageTrend)
  const bible = inputs.bibleFresh ? W_BIBLE : 0
  const findings = findingsPoints(inputs.findings)

  const raw = ci + coverage + bible + findings
  const score = Math.min(100, Math.max(0, Math.round(raw)))

  return { score, breakdown: { ci, coverage, bible, findings } }
}

// ─── CI classification + auditor (pure) ───────────────────────────────────────

const BIBLE_STALE_DAYS = 30 // bible §5: sections updated within 30 days = fresh

/**
 * Classify the observed CI state from gathered GitHub facts.
 *  - no workflow file → 'none' (no CI signal at all)
 *  - no completed runs observed → 'none'
 *  - latest completed run concluded failure → 'failing'
 *  - completed runs disagree (some success, some failure) → 'flaky'
 *  - latest (and consistent) success → 'passing'
 *
 * "Completed" = conclusion !== null. In-progress/queued runs (conclusion null)
 * are ignored for classification. Runs are sorted newest-first by createdAt so
 * the "latest" judgment is independent of gh's return order.
 */
export function classifyCi(ghStatus: GithubStatus, hasWorkflow: boolean): CiState {
  if (!hasWorkflow) return 'none'

  const completed = ghStatus.ci
    .filter((r: CiRunInfo) => r.conclusion != null)
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  if (completed.length === 0) return 'none'

  const isSuccess = (c: string | null) => String(c).toLowerCase() === 'success'
  const anySuccess = completed.some(r => isSuccess(r.conclusion))
  const anyFailure = completed.some(r => !isSuccess(r.conclusion))

  // Mixed conclusions across observed runs → flaky.
  if (anySuccess && anyFailure) return 'flaky'

  // Consistent: judge by the latest run.
  return isSuccess(completed[0].conclusion) ? 'passing' : 'failing'
}

/**
 * CI auditor — returns findings about CI health.
 *  - no workflow → critical
 *  - failing → critical
 *  - flaky → warn
 *  - none (workflow exists but no runs observed) → info
 *  - passing → no finding
 */
export function auditCi(ghStatus: GithubStatus, hasWorkflow: boolean): Finding[] {
  if (!hasWorkflow) {
    return [{ severity: 'critical', area: 'ci', message: 'no CI workflow under .github/workflows' }]
  }
  const state = classifyCi(ghStatus, hasWorkflow)
  switch (state) {
    case 'failing':
      return [{ severity: 'critical', area: 'ci', message: 'latest CI run concluded failure' }]
    case 'flaky':
      return [{ severity: 'warn', area: 'ci', message: 'CI runs are flaky (mixed pass/fail conclusions)' }]
    case 'none':
      return [{ severity: 'info', area: 'ci', message: 'no CI runs observed yet' }]
    case 'passing':
      return []
  }
}

// ─── Bible auditor (pure) ─────────────────────────────────────────────────────

/**
 * Bible freshness auditor.
 *  - no bible dir → critical
 *  - freshnessDays null (no commits touch the bible / unknown) → warn
 *  - freshnessDays > 30 → warn (stale)
 *  - <= 30 → no finding
 */
export function auditBible(freshnessDays: number | null, hasBibleDir: boolean): Finding[] {
  if (!hasBibleDir) {
    return [{ severity: 'critical', area: 'bible', message: 'no project bible at docs/bible' }]
  }
  if (freshnessDays == null) {
    return [{ severity: 'warn', area: 'bible', message: 'bible freshness unknown: no commits touch the bible' }]
  }
  if (freshnessDays > BIBLE_STALE_DAYS) {
    return [{ severity: 'warn', area: 'bible', message: `bible stale: ${freshnessDays} days since last bible commit` }]
  }
  return []
}

/** Derive the `bibleFresh` boolean for computeHealthScore from gathered facts.
 *  Fresh = bible exists AND last bible commit is within the freshness window.
 *  Null freshness (no commits / git failed) counts as NOT fresh. */
export function bibleFreshFromDays(freshnessDays: number | null, hasBibleDir: boolean): boolean {
  if (!hasBibleDir) return false
  if (freshnessDays == null) return false
  return freshnessDays <= BIBLE_STALE_DAYS
}

// ─── Invariants auditor (pure) ────────────────────────────────────────────────

/**
 * Registry-level invariants auditor (bible §3): GitHub remote, docs/bible/,
 * .github/workflows/.
 *
 * Scope decision (kept non-duplicative): auditInvariants reports only on the
 * *presence* of the three invariants — the githubRemote field plus the two
 * required directories on disk. It deliberately does NOT judge CI pass/fail or
 * bible staleness; those richer judgments belong to auditCi / auditBible.
 * It is acceptable that a missing workflow surfaces from both auditCi and
 * auditInvariants — they answer different questions (CI signal vs. invariant) —
 * but we avoid emitting two identical messages by phrasing them distinctly.
 */
export function auditInvariants(project: Project): Finding[] {
  const findings: Finding[] = []
  const root = project.localPath
  const bibleDir = project.bibleDir || 'docs/bible'

  if (!project.githubRemote) {
    findings.push({ severity: 'critical', area: 'invariants', message: 'no GitHub remote configured for project' })
  }
  if (!hasBibleDir(root, bibleDir)) {
    findings.push({ severity: 'critical', area: 'invariants', message: `missing bible invariant: ${bibleDir}/ not present` })
  }
  if (!hasWorkflowFile(root)) {
    findings.push({ severity: 'critical', area: 'invariants', message: 'missing CI invariant: no workflow under .github/workflows' })
  }
  return findings
}

// ══════════════════════════════════════════════════════════════════════════════
// Thin FS / git fact-gatherers (IMPURE). Kept below the pure core so the scoring
// + auditor functions above never call these internally — they receive facts as
// parameters. Task 7's orchestration uses these to gather facts before scoring.
// ══════════════════════════════════════════════════════════════════════════════

const WORKFLOWS_DIR = path.join('.github', 'workflows')
const BIBLE_MANIFEST = 'manifest.json' // sentinel — mirrors onboard.ts convention

/** True if <localPath>/.github/workflows/ exists AND holds ≥1 .yml/.yaml file. */
export function hasWorkflowFile(localPath: string): boolean {
  const dir = path.join(localPath, WORKFLOWS_DIR)
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
    return fs.readdirSync(dir).some(f => /\.ya?ml$/i.test(f))
  } catch {
    return false
  }
}

/** True if <localPath>/<bibleDir>/manifest.json exists — a real bible, not just
 *  an empty dir (mirrors the onboard.ts sentinel convention). */
export function hasBibleDir(localPath: string, bibleDir: string): boolean {
  return fs.existsSync(path.join(localPath, ...bibleDir.split(/[\\/]/), BIBLE_MANIFEST))
}

/**
 * Whole days since the last commit that touched <bibleDir>, via
 * `git log -1 --format=%ct -- <bibleDir>` (committer unix seconds) run in
 * localPath. Returns null if no commit touches the bible, or git is unavailable
 * / errors. Synchronous (execSync) to match the deterministic verification run.
 */
export function bibleFreshnessDays(localPath: string, bibleDir: string): number | null {
  try {
    const out = execSync(`git log -1 --format=%ct -- ${JSON.stringify(bibleDir)}`, {
      cwd: localPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!out) return null
    const committedSec = Number(out)
    if (!Number.isFinite(committedSec)) return null
    const nowSec = Date.now() / 1000
    const days = Math.floor((nowSec - committedSec) / 86_400)
    return days < 0 ? 0 : days
  } catch {
    return null
  }
}
