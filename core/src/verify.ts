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
import { scaffoldCi, BIBLE_SCAFFOLD_MARKER } from './scaffold.js'
import { db, verificationDb, projectsDb } from './db.js'
import { eventBus } from './events.js'

// ─── Health score (pure, bible §5) ───────────────────────────────────────────

export type CiState = 'passing' | 'failing' | 'flaky' | 'none'
export type CoverageTrend = 'improving' | 'stable' | 'declining' | 'unknown'

export interface HealthScoreInputs {
  /** Observed CI state. MEASURED ⟺ ci !== 'none' (≥1 decisive pass/fail run). Both
   *  "no workflow" and "workflow present but never run" collapse to 'none' — neither
   *  is a real CI-health measurement, so both are EXCLUDED from the score. */
  ci: CiState
  /** MEASURED ⟺ coverageTrend !== 'unknown' (a coverage summary was present). */
  coverageTrend: CoverageTrend
  /** Whether the bible holds AUTHORED content (not just an onboarding scaffold). A
   *  bare scaffold is UNMEASURED/excluded; an authored bible — even uncommitted
   *  (D-028) — is measured (F-032b: existence, not commit history). */
  bibleAuthored: boolean
  findings: Finding[]
}

/** Per-dimension earned points (already weighted), or **null when that dimension was
 *  UNMEASURED** (excluded from the score — neither credit nor demerit; the UI renders
 *  it as "not measured", never a 0/40 bar). */
export interface HealthBreakdown {
  ci: number | null
  coverage: number | null
  bible: number | null
  findings: number | null
}

export interface HealthScore {
  /** Rounded integer in [0,100], or **null when NO dimension was measured**
   *  (insufficient signal — e.g. a brand-new onboarded project). */
  score: number | null
  breakdown: HealthBreakdown
}

// Per-dimension weights (bible §5).
const W_CI = 40
const W_COVERAGE = 20
const W_BIBLE = 20
const W_FINDINGS = 20

// Open-finding penalties applied against the findings component.
const PENALTY_CRITICAL = 10
const PENALTY_WARN = 2

// ─── Scoring policy (F-032 / CLAIM-07-3): PRORATE over MEASURED dimensions ─────
// The health score is the honest reading of "neutral for unknown": an UNMEASURED
// dimension is EXCLUDED from BOTH numerator and denominator — it neither helps nor
// hurts (NOT credited full, NOT zeroed). The score is the earned fraction over the
// total weight of the dimensions we could actually measure:
//     score = round( Σ earned(measured) / Σ weight(measured) · 100 )
// If NOTHING is measured → score is NULL ("insufficient signal"): a brand-new
// onboarded project (scaffold CI that never ran, no coverage, an unedited scaffold
// bible) is null, NOT 100. A MEASURED problem still demerits its dimension exactly as
// before (failing CI → 0/40, flaky → 20/40, declining coverage → 10/20).
//   MEASURED ⟺  ci: a decisive CI run was observed (ci !== 'none')
//               coverage: a coverage summary was present (trend !== 'unknown')
//               bible: AUTHORED content exists (not a bare scaffold)
//               findings: at least one of ci/coverage/bible is measured — the
//                 open-findings QUALITY only contextualizes a project with real
//                 signal, so a zero-signal scaffold has no findings dimension either.

/** Earned CI points for a MEASURED ci state (caller guards ci !== 'none'). */
function ciEarned(ci: CiState): number {
  switch (ci) {
    case 'passing': return W_CI          // 40
    case 'flaky': return W_CI * 0.5      // 20 — MEASURED partial
    case 'failing': return 0             // MEASURED problem
    case 'none': return 0                // unmeasured — never counted (guarded)
  }
}

/** Earned coverage points for a MEASURED trend (caller guards trend !== 'unknown'). */
function coverageEarned(trend: CoverageTrend): number {
  switch (trend) {
    case 'improving':
    case 'stable': return W_COVERAGE     // 20
    case 'declining': return W_COVERAGE * 0.5 // 10 — MEASURED regression
    case 'unknown': return 0             // unmeasured — never counted (guarded)
  }
}

/**
 * Classify a per-project coverage trend from the current vs. prior measured
 * line-coverage %. PURE — no I/O; the caller gathers both numbers. `tol` is the
 * dead-band (percentage points) that absorbs measurement noise so a tiny wobble
 * reads as 'stable' rather than improving/declining. Order matters:
 *  - current null / non-finite → 'unknown' (no signal — stays neutral, no penalty).
 *  - prior null / non-finite  → 'stable' (first real reading: a baseline is
 *    established, nothing to regress from — full marks, not claiming improvement).
 *  - current ≥ prior + tol    → 'improving'.
 *  - |current − prior| ≤ tol  → 'stable'.
 *  - current < prior − tol    → 'declining'.
 */
export function classifyCoverageTrend(
  currentPct: number | null,
  priorPct: number | null,
  tol = 0.1,
): CoverageTrend {
  if (currentPct == null || !Number.isFinite(currentPct)) return 'unknown'
  if (priorPct == null || !Number.isFinite(priorPct)) return 'stable'
  if (currentPct >= priorPct + tol) return 'improving'
  if (Math.abs(currentPct - priorPct) <= tol) return 'stable'
  return 'declining'
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
 * Pure health score: PRORATE earned points over the total weight of the MEASURED
 * dimensions (see the policy note above). Unmeasured dimensions → null in the
 * breakdown and excluded from the ratio; if none is measured, score is null.
 */
export function computeHealthScore(inputs: HealthScoreInputs): HealthScore {
  const ciMeasured = inputs.ci !== 'none'
  const coverageMeasured = inputs.coverageTrend !== 'unknown'
  const bibleMeasured = inputs.bibleAuthored
  // Open-findings quality is only meaningful once the project has SOME real signal —
  // otherwise (a zero-signal scaffold) there is nothing to contextualize, so findings
  // is unmeasured too and the whole score is null.
  const findingsMeasured = ciMeasured || coverageMeasured || bibleMeasured

  const breakdown: HealthBreakdown = {
    ci: ciMeasured ? ciEarned(inputs.ci) : null,
    coverage: coverageMeasured ? coverageEarned(inputs.coverageTrend) : null,
    bible: bibleMeasured ? W_BIBLE : null, // authored bible → full; quality can't be measured
    findings: findingsMeasured ? findingsPoints(inputs.findings) : null,
  }

  let earned = 0
  let weight = 0
  if (ciMeasured) { earned += breakdown.ci!; weight += W_CI }
  if (coverageMeasured) { earned += breakdown.coverage!; weight += W_COVERAGE }
  if (bibleMeasured) { earned += breakdown.bible!; weight += W_BIBLE }
  if (findingsMeasured) { earned += breakdown.findings!; weight += W_FINDINGS }

  const score = weight === 0 ? null : Math.min(100, Math.max(0, Math.round((earned / weight) * 100)))
  return { score, breakdown }
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
 *  - no bible dir → critical (invariant absent)
 *  - freshnessDays null (no commits touch the bible / unknown) → info (UNMEASURABLE,
 *    no penalty — onboarding deliberately leaves the bible scaffold uncommitted
 *    (D-028), so "no commits touch the bible" is expected, not a defect; F-032)
 *  - freshnessDays > 30 → warn (MEASURED staleness — commits exist but are old)
 *  - <= 30 → no finding
 */
export function auditBible(freshnessDays: number | null, hasBibleDir: boolean): Finding[] {
  if (!hasBibleDir) {
    return [{ severity: 'critical', area: 'bible', message: 'no project bible at artifacts/bible' }]
  }
  if (freshnessDays == null) {
    return [{ severity: 'info', area: 'bible', message: 'bible freshness unknown: no commits touch the bible yet' }]
  }
  if (freshnessDays > BIBLE_STALE_DAYS) {
    return [{ severity: 'warn', area: 'bible', message: `bible stale: ${freshnessDays} days since last bible commit` }]
  }
  return []
}

/** Pure "is the bible fresh?" helper: bible exists AND last bible commit is within
 *  the freshness window; null freshness (no commits / git failed) counts as NOT
 *  fresh. NOTE: since F-032 the HEALTH SCORE's bible component is existence-based
 *  (computeHealthScore takes `bibleAuthored`), so this no longer feeds the score — it
 *  remains a standalone freshness predicate other callers/tests may use. */
export function bibleFreshFromDays(freshnessDays: number | null, hasBibleDir: boolean): boolean {
  if (!hasBibleDir) return false
  if (freshnessDays == null) return false
  return freshnessDays <= BIBLE_STALE_DAYS
}

// ─── Invariants auditor (pure) ────────────────────────────────────────────────

/** Pre-gathered presence facts for the three bible §3 invariants that require
 *  disk reads. The githubRemote invariant is read from the project itself. */
export interface InvariantFacts {
  hasBible: boolean      // artifacts/bible/ present (real bible — manifest sentinel)
  hasWorkflow: boolean   // .github/workflows/ holds ≥1 workflow file
}

/**
 * Registry-level invariants auditor (bible §3): GitHub remote, artifacts/bible/,
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
  const bibleDir = project.bibleDir || 'artifacts/bible'

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
 * True if the bible holds AUTHORED content, not just an onboarding scaffold — the
 * signal the health score's bible dimension is MEASURED on (F-032 rework). Concrete,
 * commit-independent heuristic: the bible has a manifest AND ≥1 section whose body no
 * longer carries the scaffold sentinel (`BIBLE_SCAFFOLD_MARKER`) that every onboarding
 * placeholder embeds — i.e. at least one section has been authored (its placeholder
 * replaced). A pure scaffold (every section still the marker) is NOT authored, so a
 * brand-new onboarded project's bible is UNMEASURED — never credited full. Preserves
 * F-032b intent: an authored-but-UNCOMMITTED bible still counts (no git dependency).
 * Never throws (missing/unreadable sections → not authored), matching the other
 * gatherers' defensive posture.
 */
export function hasAuthoredBible(localPath: string, bibleDir: string): boolean {
  if (!hasBibleDir(localPath, bibleDir)) return false
  const sectionsDir = path.join(localPath, ...bibleDir.split(/[\\/]/), 'sections')
  try {
    const files = fs.readdirSync(sectionsDir).filter(f => /\.md$/i.test(f))
    for (const f of files) {
      const body = fs.readFileSync(path.join(sectionsDir, f), 'utf8')
      if (!body.includes(BIBLE_SCAFFOLD_MARKER)) return true // an authored (de-scaffolded) section
    }
    return false // manifest present but every section is still an unedited scaffold
  } catch {
    return false
  }
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

/**
 * Measured overall line-coverage %, read from
 * <localPath>/coverage/coverage-summary.json (the istanbul/vitest/jest
 * `json-summary` standard — `total.lines.pct`). Returns the pct only when it is a
 * finite number in [0, 100]; every failure mode — missing file, unreadable,
 * garbled JSON, missing / wrong-typed field, out-of-range — yields null and never
 * throws (mirrors bibleFreshnessDays' defensive posture). Synchronous read matches
 * the deterministic single-shot verify run.
 */
export function readCoveragePct(localPath: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(localPath, 'coverage', 'coverage-summary.json'), 'utf8')
    const pct = (JSON.parse(raw) as { total?: { lines?: { pct?: unknown } } })?.total?.lines?.pct
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null
    return pct
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
    coveragePct: report.coveragePct ?? null,
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
  // Bible dimension is MEASURED on AUTHORED content (F-032), not commit-freshness, so
  // a freshly-authored-but-uncommitted bible (D-028) counts while a bare scaffold does
  // NOT inflate the score. freshnessDays still feeds auditBible's soft staleness signal
  // (a warn finding) via composeFindings below.
  const bibleAuthored = hasAuthoredBible(project.localPath, project.bibleDir)
  // Live coverage trend: read this project's measured line-coverage % from its
  // coverage/coverage-summary.json and compare it against the coverage_pct
  // persisted on the project's previous report (read BEFORE we persist this run's).
  // No coverage file → null → 'unknown' → neutral (no penalty); the signal stays
  // inert for uninstrumented projects and only activates once one emits a report.
  const priorRow = verificationDb.latestVerificationReport.get(project.id) as
    | { coverage_pct?: number | null }
    | undefined
  const priorPct = priorRow?.coverage_pct ?? null
  const coveragePct = readCoveragePct(project.localPath)
  const coverageTrend = classifyCoverageTrend(coveragePct, priorPct)

  // ── compose + score (pure) ──────────────────────────────────────────────────
  const findings = composeFindings(project, gh, { hasBible, hasWorkflow, freshnessDays })
  const { score, breakdown } = computeHealthScore({ ci, coverageTrend, bibleAuthored, findings })

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
    coveragePct,
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
