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
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Finding, Project, GithubStatus, CiRunInfo, VerificationReport } from '@k/shared'
import { getGithubStatus } from './github.js'
import { scaffoldCi } from './scaffold.js'
import { db, verificationDb, projectsDb } from './db.js'
import { eventBus } from './events.js'

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
 *  - no decisive runs observed → 'none'
 *  - latest decisive run concluded failure → 'failing'
 *  - decisive runs disagree (some success, some failure) → 'flaky'
 *  - latest (and consistent) success → 'passing'
 *
 * Only DECISIVE conclusions count: 'success' and the failure-class conclusions
 * ('failure', 'timed_out', 'action_required', 'startup_failure'). Neutral
 * outcomes ('skipped', 'cancelled', 'neutral', 'stale') and in-progress runs
 * (conclusion null) carry no pass/fail signal and are ignored — otherwise a
 * merely-cancelled run would drag a clean repo to 'flaky'. Runs are sorted
 * newest-first by createdAt so the "latest" judgment is independent of gh order.
 */
const CI_SUCCESS = 'success'
// GitHub Actions conclusions that mean the run actually failed (vs. neutral).
const CI_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure'])

export function classifyCi(ghStatus: GithubStatus, hasWorkflow: boolean): CiState {
  if (!hasWorkflow) return 'none'

  const norm = (c: string | null) => String(c).toLowerCase()
  const isSuccess = (c: string | null) => norm(c) === CI_SUCCESS
  const isFailure = (c: string | null) => CI_FAILURE_CONCLUSIONS.has(norm(c))

  // Keep only runs that carry a decisive pass/fail signal; drop neutral + null.
  const decisive = ghStatus.ci
    .filter((r: CiRunInfo) => isSuccess(r.conclusion) || isFailure(r.conclusion))
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  if (decisive.length === 0) return 'none'

  const anySuccess = decisive.some(r => isSuccess(r.conclusion))
  const anyFailure = decisive.some(r => isFailure(r.conclusion))

  // Mixed conclusions across observed runs → flaky.
  if (anySuccess && anyFailure) return 'flaky'

  // Consistent: judge by the latest run.
  return isSuccess(decisive[0].conclusion) ? 'passing' : 'failing'
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

/** Pre-gathered presence facts for the three bible §3 invariants that require
 *  disk reads. The githubRemote invariant is read from the project itself. */
export interface InvariantFacts {
  hasBible: boolean      // docs/bible/ present (real bible — manifest sentinel)
  hasWorkflow: boolean   // .github/workflows/ holds ≥1 workflow file
}

/**
 * Registry-level invariants auditor (bible §3): GitHub remote, docs/bible/,
 * .github/workflows/. PURE — like the other auditors it receives already-gathered
 * facts (the two disk-presence booleans) and reads only plain fields off the
 * project; it never touches the filesystem itself. Task 7's orchestration gathers
 * the facts once (via hasBibleDir / hasWorkflowFile below) and feeds both the
 * score inputs and this auditor, so there is a single source of truth and no
 * redundant I/O.
 *
 * Scope decision (kept non-duplicative): auditInvariants reports only on the
 * *presence* of the three invariants. It deliberately does NOT judge CI pass/fail
 * or bible staleness; those richer judgments belong to auditCi / auditBible. It is
 * acceptable that a missing workflow surfaces from both auditCi and auditInvariants
 * — they answer different questions (CI signal vs. invariant) — but we avoid
 * emitting two identical messages by phrasing them distinctly.
 */
/** Exact message for the GitHub-remote invariant. Shared with composeFindings so
 *  its dedupe filter keys on this constant (compile-checked) rather than a loose
 *  substring that could silently drift if the copy is ever reworded. */
export const MSG_NO_REMOTE = 'no GitHub remote configured for project'

export function auditInvariants(project: Project, facts: InvariantFacts): Finding[] {
  const findings: Finding[] = []
  const bibleDir = project.bibleDir || 'docs/bible'

  if (!project.githubRemote) {
    findings.push({ severity: 'critical', area: 'invariants', message: MSG_NO_REMOTE })
  }
  if (!facts.hasBible) {
    findings.push({ severity: 'critical', area: 'invariants', message: `missing bible invariant: ${bibleDir}/ not present` })
  }
  if (!facts.hasWorkflow) {
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
 * / errors. Uses execFileSync (no shell) so bibleDir is passed as a literal
 * argv entry — no shell-quoting/injection concerns and correct on Windows where
 * paths may contain spaces. Synchronous to match the deterministic verify run.
 */
export function bibleFreshnessDays(localPath: string, bibleDir: string): number | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', bibleDir], {
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

// ══════════════════════════════════════════════════════════════════════════════
// Orchestration (IMPURE conductor). Gathers facts via the helpers above + the
// GitHub cache, scores with the pure core, persists, and broadcasts. The pure
// functions above stay untouched. Signature takes a Project (not an id): the
// route already does getProject→404, so passing the resolved project keeps this
// free of DB lookups + a redundant "unknown id" error type.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Compose the scored finding set so each ROOT CAUSE is counted once. auditCi and
 * auditBible own the rich CI/bible judgments (incl. the missing-workflow and
 * missing-bible criticals). auditInvariants would emit duplicate missing-workflow
 * / missing-bible criticals for the same root cause, double-penalizing the score
 * (e.g. no workflow → −10 in ci AND −10 in invariants = −20 for one problem), so
 * from auditInvariants we keep ONLY the GitHub-remote invariant, which neither
 * other auditor covers.
 */
function composeFindings(
  project: Project,
  gh: GithubStatus,
  facts: { hasBible: boolean; hasWorkflow: boolean; freshnessDays: number | null },
): Finding[] {
  const ci = auditCi(gh, facts.hasWorkflow)
  const bible = auditBible(facts.freshnessDays, facts.hasBible)
  const remoteOnly = auditInvariants(project, {
    hasBible: facts.hasBible,
    hasWorkflow: facts.hasWorkflow,
  }).filter(f => f.area === 'invariants' && f.message === MSG_NO_REMOTE)
  return [...ci, ...bible, ...remoteOnly]
}

/** Atomic persist: write the report row AND update the project's health in one
 *  SQLite transaction. Either both land or neither — a failure on the second
 *  write rolls back the first, so a stored report can never disagree with the
 *  fleet health shown on the card. (better-sqlite3 transactions are synchronous.) */
const persistReport = db.transaction((report: VerificationReport): void => {
  verificationDb.insertVerificationReport.run({
    id: report.id,
    projectId: report.projectId,
    score: report.score,
    findings: JSON.stringify(report.findings),
    fixesApplied: JSON.stringify(report.fixesApplied),
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    scoreBreakdown: JSON.stringify(report.breakdown),
  })
  projectsDb.updateProjectHealth.run({
    id: report.projectId,
    healthScore: report.score,
    lastVerifiedAt: report.completedAt,
  })
})

/**
 * Run a deterministic single-shot verification for an already-resolved project:
 * gather facts, score, persist the report, update project health, broadcast, and
 * return the in-memory report. Synchronous by design (matches the pure engine).
 */
export function runVerification(project: Project): VerificationReport {
  const startedAt = Date.now()

  // ── gather facts (impure) ───────────────────────────────────────────────────
  const hasWorkflow = hasWorkflowFile(project.localPath)
  const hasBible = hasBibleDir(project.localPath, project.bibleDir)
  const freshnessDays = bibleFreshnessDays(project.localPath, project.bibleDir)
  const gh = getGithubStatus(project.id)
  const ci = classifyCi(gh, hasWorkflow)
  const bibleFresh = bibleFreshFromDays(freshnessDays, hasBible)
  // No coverage signal in this milestone — default to the neutral 'unknown'
  // (plan risk #1). An agent layer will supply a real trend later; until then we
  // do not penalize coverage and do not fetch the prior report (unused here).
  const coverageTrend: CoverageTrend = 'unknown'

  // ── compose + score (pure) ──────────────────────────────────────────────────
  const findings = composeFindings(project, gh, { hasBible, hasWorkflow, freshnessDays })
  const { score, breakdown } = computeHealthScore({ ci, coverageTrend, bibleFresh, findings })

  // ── build the in-memory report (camelCase, real arrays/objects) ─────────────
  const report: VerificationReport = {
    id: randomUUID(),
    projectId: project.id,
    score,
    findings,
    fixesApplied: [], // populated below (deterministic CI-auditor fix)
    startedAt,
    completedAt: Date.now(),
    breakdown,
  }

  // ── deterministic CI-auditor fix (Task 8) ────────────────────────────────────
  // The SCORE above already reflects the state AT verification time (CI missing →
  // auditCi critical + ci component 0). We do NOT re-gather or re-score after
  // fixing. When no workflow exists, scaffold a starter CI file into the working
  // tree (uncommitted — a proposed change for operator review, NOT a push) and
  // record it in fixesApplied. The NEXT verify will see the workflow. This must
  // run BEFORE persistReport so fixesApplied is persisted. Robust: a scaffold
  // failure must not fail the (already-successful) verification.
  if (!hasWorkflow) {
    try {
      for (const rel of scaffoldCi(project.localPath)) {
        report.fixesApplied.push(`scaffolded CI workflow: ${rel}`)
      }
    } catch {
      // path-guard / fs error: leave fixesApplied untouched, do not throw out.
    }
  }

  // ── persist atomically (report row + project health in one transaction, so a
  //    mid-write failure can't leave a stored report with stale fleet health).
  //    Note: if a CI file was just scaffolded and persistReport throws, the file
  //    stays on disk with no recorded report — self-healing (next verify sees the
  //    workflow as already-present and emits no new fixesApplied entry). ────────
  persistReport(report)

  // ── broadcast the in-memory report (NOT the stringified DB form). Outside the
  //    transaction by necessity — a broadcast can't be rolled back. ────────────
  eventBus.broadcast({ type: 'verification_update', report })

  return report
}
