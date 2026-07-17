/**
 * Skills module — Skill/Hook/Workflow Registry
 *
 * Provides:
 *   - rowToSkill: DB row → Skill shape
 *   - listSkills / registerSkill: CRUD
 *   - triggerSkill: fire a skill as a run
 *   - startEventListener: subscribe to internal eventBus for event-triggered skills
 *   - startScheduler: cron loop for schedule-triggered skills
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { schedule as cronSchedule, validate as cronValidate } from 'node-cron'
import type { Skill, CreateSkill, SkillEval } from '@k/shared'
import { db, skillsDb, skillEvalsDb, projectsDb } from './db.js'
import { startRun, REPO_ROOT, type StartRunOptions } from './supervisor.js'
import { fileURLToPath } from 'url'
import { eventBus } from './events.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { isPathWithin } from './paths.js'
import { resolveSkillRoots, confineToRoots, type SkillRoots } from './skill-roots.js'
import { registeredProjectSkillRoots } from './host-discovery.js'
import { budgetGate } from './budget-governor.js'
import { startPipelineRun } from './pipeline-defs.js'

// agent-config is READ-ONLY bundled assets, resolved __dirname-relative (like
// agent-config.ts / skill-roots.ts) — NOT via REPO_ROOT, which the desktop app
// redirects to a writable, agent-config-LESS runtime dir. Using it here would make
// every built-in skill silently no-op under packaging. SKILLS_ROOT and the source
// base (readSkillSource below) share this same root, so the F-069 confinement holds.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_ROOT = path.join(__dirname, '../../')

/** The ONLY directory `readSkillSource` will read a skill's `source` as a file from. A
 *  `source` resolving outside this root (an absolute path, a `..` escape) is treated as raw
 *  inline prompt text — NEVER an unconfined file read (F-069 security review). */
const SKILLS_ROOT = path.join(ASSETS_ROOT, 'agent-config', 'skills')

// Prepared once at module load — sets runId on a skill_run after the run is created
const patchSkillRunId = db.prepare(`UPDATE skill_runs SET runId = ? WHERE id = ?`)

export function rowToSkill(r: Record<string, unknown>): Skill {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description != null ? String(r.description) : undefined,
    type: r.type as Skill['type'],
    source: String(r.source),
    triggerType: r.triggerType as Skill['triggerType'],
    schedule: r.schedule != null ? String(r.schedule) : null,
    eventTrigger: r.eventTrigger != null ? String(r.eventTrigger) : null,
    // Task B.3: snake_case column (the v15 ALTER — SCHEMA_SENTINEL), unlike its
    // camelCase siblings above (schedule/eventTrigger predate that convention shift).
    pipelineDefId: r.pipeline_def_id != null ? String(r.pipeline_def_id) : null,
    enabled: Number(r.enabled) === 1,
    createdAt: Number(r.createdAt),
  }
}

export function listSkills(): Skill[] {
  return (skillsDb.listSkills.all() as Record<string, unknown>[]).map(rowToSkill)
}

// ─── Built-in (filesystem) skills ────────────────────────────────────────────

/**
 * The authored `agent-config/skills/*` workflows the harness ships with. They live
 * as `SKILL.md` files (agent-invokable), and are also seeded into the skills table
 * at bootstrap so they appear — and are triggerable — from the Skills tab.
 *
 * Each entry is `CreateSkill`-shaped and MUST satisfy the same boundary
 * validation POST /api/skills enforces (a `manual` trigger needs neither a cron
 * `schedule` nor an `eventTrigger`), so seeding can never store an invalid skill
 * that would be silently dropped at trigger time.
 */
export const BUILTIN_SKILLS: readonly CreateSkill[] = [
  {
    name: 'onboarding',
    description:
      'Scaffold a registered project’s bible + CI to satisfy the three bible §3 invariants (GitHub remote, bible, CI). Idempotent.',
    type: 'workflow',
    source: 'agent-config/skills/onboarding/SKILL.md',
    triggerType: 'manual',
  },
  {
    name: 'verify-project',
    description:
      'Run the Layer-2 verification agent team (CI auditor, coverage scout, PR reviewer, doc-freshness) and apply safe fixes via PR only.',
    type: 'workflow',
    source: 'agent-config/skills/verify-project/SKILL.md',
    triggerType: 'manual',
  },
  {
    name: 'create-web-ui-artifact',
    description:
      'Author a project-specific, self-contained interactive UI demo (hybrid-glass, offline, sandbox-safe) and compile it into a renderable UI artifact via POST /api/ui-artifact/compile.',
    type: 'workflow',
    source: 'agent-config/skills/create-web-ui-artifact/SKILL.md',
    triggerType: 'manual',
  },
] as const

/**
 * Idempotently register the built-in skills. Existing rows (matched by name) are
 * left untouched so a user’s edits (enabled flag, schedule) are preserved across
 * restarts. Returns the names that were newly inserted. Called at bootstrap.
 */
export function seedBuiltinSkills(): string[] {
  const created: string[] = []
  for (const skill of BUILTIN_SKILLS) {
    if (skillsDb.getSkillByName.get(skill.name)) continue
    registerSkill(skill)
    created.push(skill.name)
  }
  if (created.length) console.log(`[skills] seeded built-in skills: ${created.join(', ')} ✓`)
  return created
}

export function registerSkill(opts: CreateSkill): Skill {
  const id = randomUUID()
  const now = Date.now()
  skillsDb.insertSkill.run({
    id,
    name: opts.name,
    description: opts.description ?? null,
    type: opts.type,
    source: opts.source,
    triggerType: opts.triggerType,
    schedule: opts.schedule ?? null,
    eventTrigger: opts.eventTrigger ?? null,
    // Honor an explicit enabled flag; omitted defaults to enabled (1). A skill created
    // `enabled:false` must land DISABLED so a "disabled" schedule/event skill can't fire
    // (the scheduler/event listener gate on `enabled`). Only an explicit `false` disarms.
    enabled: opts.enabled === false ? 0 : 1,
    createdAt: now,
    // D-069 canonical key: a k-native (automation-registry) skill's qualified key
    // IS its bare name — qualified_key is NOT NULL UNIQUE post-v7, so name
    // uniqueness for k-native rows is preserved through the new constraint.
    qualifiedKey: opts.name,
  })
  return rowToSkill(skillsDb.getSkill.get(id) as Record<string, unknown>)
}

/**
 * Resolve a skill's EXECUTABLE content. A built-in skill's `source` is a repo-relative
 * `SKILL.md` PATH UNDER `agent-config/skills/`; read its CONTENTS so a dispatched run
 * EXECUTES the skill's instructions rather than just reading+summarizing the bare path (the
 * F-069 no-op). A user-authored inline prompt is returned verbatim.
 *
 * SECURITY (F-069 review): the file read is CONFINED to the skills root. `skill.source` is
 * only validated as `z.string().min(1).max(2000)` with no path confinement, so an
 * authenticated caller could register `source` = an absolute path to a secret (`.env`, an
 * SSH key, another project's file) and have its contents pulled into the agent's prompt (and
 * exfiltrated via a PR). So we read a file ONLY when the resolved absolute path stays STRICTLY
 * INSIDE `SKILLS_ROOT` (isPathWithin — rejects absolute paths and `..` traversal); anything
 * else falls back to treating `source` as RAW inline text, never a file read. A
 * non-existent/unreadable in-root file also degrades to raw. As a second gate, the REAL
 * (symlink-resolved) path must ALSO stay inside the real skills root — a symlink planted
 * in-root that points outside the repo is refused (realpathSync confinement); a throw
 * (nonexistent) or an out-of-root real path degrades to raw, exactly like any other
 * non-confined source. Pure + exported for unit-testing.
 *
 * DISCOVERED rows (D-069): a skill whose db row carries `origin_path` is host-
 * discovered — its content lives on host disk, and the read routes through
 * confineToRoots (skill-roots.ts): the explicit allowlisted-roots set (K assets,
 * ~/.claude/skills, the plugin cache, each REGISTERED project's .claude/skills),
 * string gate + realpath gate per root. ANY failure — unconfined path, planted
 * symlink, vanished file, empty content — degrades to the raw `source` text
 * exactly like the k-native path (for a discovered row, `source` IS its origin
 * path string: honest provenance, never file content). k-native rows and Skill
 * objects with no db row take the pre-D-069 branch byte-identically. `opts.roots`
 * is injectable for tests (default: the real host roots + registered projects).
 */
export function readSkillSource(skill: Skill, opts: { roots?: SkillRoots } = {}): string {
  // Discovered-row detection is a db lookup by id (the wire Skill shape carries no
  // catalog columns — GET /api/skills stays byte-compatible). An unknown id (unit
  // tests hand-build Skill objects) has no row → the k-native branch, as today.
  const row = skillsDb.getSkill.get(skill.id) as Record<string, unknown> | undefined
  const originPath = row?.origin_path != null ? String(row.origin_path) : null
  if (originPath) {
    try {
      const roots = opts.roots ?? resolveSkillRoots({ projectRoots: registeredProjectSkillRoots() })
      const confined = confineToRoots(path.join(originPath, 'SKILL.md'), roots)
      if (confined) {
        const contents = fs.readFileSync(confined.real, 'utf8')
        if (contents.trim().length > 0) return contents
      }
    } catch {
      /* unreadable / unresolvable — degrade to the raw source below */
    }
    return skill.source
  }
  const abs = path.isAbsolute(skill.source) ? skill.source : path.join(ASSETS_ROOT, skill.source)
  if (isPathWithin(SKILLS_ROOT, abs)) {
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        // Symlink hardening (F-069): the STRING path is in-root, but a symlink planted
        // inside SKILLS_ROOT could resolve OUTSIDE the repo. Require the REAL (symlink-
        // resolved) path to STILL be within the real skills root before reading.
        // realpathSync THROWS on a nonexistent path — this is fail-safe: any throw, or a
        // real path outside the root, falls through to the raw source (NO file read),
        // exactly as an out-of-root source already does.
        const realRoot = fs.realpathSync(SKILLS_ROOT)
        const real = fs.realpathSync(abs)
        if (isPathWithin(realRoot, real)) {
          const contents = fs.readFileSync(real, 'utf8')
          if (contents.trim().length > 0) return contents
        }
      }
    } catch {
      /* unreadable / unresolvable — fall through to the raw source */
    }
  }
  return skill.source
}

/**
 * Build the run prompt for a triggered skill: an EXECUTE instruction wrapping the skill's
 * actual CONTENTS (F-069), not the bare SKILL.md path (which made the agent read the file,
 * summarize it, and exit — $ for a no-op). Pure + exported for unit-testing.
 */
export function buildSkillRunPrompt(skill: Skill): string {
  return [
    `Execute the following skill ("${skill.name}"). Carry out its instructions against the`,
    `current working directory / selected project — do NOT merely read or summarize it.`,
    ``,
    `"""`,
    readSkillSource(skill),
    `"""`,
  ].join('\n')
}

export async function triggerSkill(
  skillId: string,
  triggeredBy: string,
  opts: { projectId?: string } = {},
): Promise<{ skillRunId: string; runId: string } | { pipelineRunId: string }> {
  const row = skillsDb.getSkill.get(skillId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`Skill not found: ${skillId}`)
  const skill = rowToSkill(row)

  // Optional PROJECT SELECTOR (F-069): a skill run may target a registered project — resolve
  // its checkout as the run's cwd so the skill EXECUTES against that project (startRun makes
  // the worktree + records the projectId). No projectId → runs against K (cwd = repo root),
  // exactly as the scheduler/event paths do.
  const runOpts: StartRunOptions = {}
  if (opts.projectId) {
    const projectRow = projectsDb.getProject.get(opts.projectId) as Record<string, unknown> | undefined
    if (!projectRow) throw new Error(`Project not found: ${opts.projectId}`)
    runOpts.cwd = String(projectRow.local_path)
    runOpts.projectId = opts.projectId
  }

  // Task B.3 review fix: a skill/routine carrying a `pipelineDefId` targets a PIPELINE
  // definition instead of a plain skill run — start it via the SAME engine seam the
  // operator's `POST /api/pipelines/:id/run` and K's `delegate_pipeline` funnel through
  // (pipeline-defs.ts::startPipelineRun). THIS is now the ONE branch point every trigger
  // path shares: this function's own callers (the MANUAL `POST /api/skills/:id/trigger`
  // route, and startEventListener's event dispatch below) get it directly; fireScheduledSkill
  // (the cron path) delegates straight to this function. Previously the branch lived ONLY in
  // fireScheduledSkill, so a pipeline-targeted routine fired manually silently ran as a plain
  // skill instead — fixed by hoisting the branch here. Deliberately bypasses the skill_runs
  // bookkeeping below — a pipeline run tracks its OWN lifecycle in
  // pipeline_runs/pipeline_stages/pipeline_edges, not skill_runs. The optional project selector
  // above still applies (a pipeline-targeted skill run against a chosen project's checkout);
  // no projectId → REPO_ROOT, exactly like the pre-existing scheduler/event dispatch paths.
  if (skill.pipelineDefId) {
    return startPipelineRun(skill.pipelineDefId, {
      cwd: runOpts.cwd ?? REPO_ROOT,
      goal: skill.description || `Pipeline run for routine "${skill.name}" (${triggeredBy})`,
      projectId: opts.projectId ?? null,
    })
  }

  const skillRunId = randomUUID()
  const now = Date.now()

  // Insert skill_run with no runId yet
  skillsDb.insertSkillRun.run({
    id: skillRunId,
    skillId,
    runId: null,
    triggeredBy,
    startedAt: now,
    completedAt: null,
    status: 'running',
  })

  // Launch the underlying run: the skill's EXECUTE-instruction prompt (its contents, F-069),
  // in the selected project's cwd when one was chosen.
  const run = await startRun(buildSkillRunPrompt(skill), runOpts)

  // Wire the supervised-run completion lifecycle (patch runId, finalize on
  //   terminal, race-backstopped) — shared via run-lifecycle.ts. NOTE: this gives
  //   triggerSkill the await/subscribe race backstop it previously lacked (a latent
  //   leaked-'running'-row fix folded into the unification).
  trackSupervisedRun(run.id, {
    onStarted: rid => patchSkillRunId.run(rid, skillRunId),
    finalize: status =>
      skillsDb.updateSkillRunStatus.run(status === 'done' ? 'completed' : 'failed', Date.now(), skillRunId),
  })

  return { skillRunId, runId: run.id }
}

/**
 * Fire a SCHEDULE-triggered skill (the cron path — Task B.3). Delegates straight to
 * triggerSkill, which is the SINGLE branch point for `pipelineDefId` → startPipelineRun (review
 * fix: that branch used to live only here, duplicated, and — worse — the MANUAL trigger path
 * never got it at all; see triggerSkill's own doc comment). A schedule-triggered routine has no
 * per-run project selector (no `opts.projectId` is passed), so this is byte-identical to the
 * pre-review-fix behavior: cwd REPO_ROOT for the pipeline branch, and REPO_ROOT-scoped for the
 * plain-skill fallback, exactly as before. Kept as its own named export because the scheduler's
 * cron callback calls it explicitly (not triggerSkill directly) — the distinct name documents
 * that contract at the call site.
 */
export async function fireScheduledSkill(
  skillId: string,
  triggeredBy: string,
): Promise<{ skillRunId: string; runId: string } | { pipelineRunId: string }> {
  return triggerSkill(skillId, triggeredBy)
}

// ─── Skill eval-harness testing ──────────────────────────────────────────────

const EVAL_VERDICT_PASS = 'EVAL VERDICT: PASS'
const EVAL_VERDICT_FAIL = 'EVAL VERDICT: FAIL'

/** DB row → SkillEval shape. regression stored 1/0 → boolean. */
export function rowToSkillEval(r: Record<string, unknown>): SkillEval {
  return {
    id: String(r.id),
    skillId: String(r.skillId),
    runId: r.runId != null ? String(r.runId) : null,
    status: r.status as SkillEval['status'],
    regression: Number(r.regression) === 1,
    baselineEvalId: r.baselineEvalId != null ? String(r.baselineEvalId) : null,
    createdAt: Number(r.createdAt),
    completedAt: r.completedAt != null ? Number(r.completedAt) : null,
  }
}

export function listSkillEvals(skillId: string): SkillEval[] {
  return (skillEvalsDb.listSkillEvals.all(skillId) as Record<string, unknown>[]).map(rowToSkillEval)
}

/** Build the eval prompt: instruct the agent to apply the eval-harness
 *  methodology to the target skill's source and end with a machine-readable
 *  verdict line. Embeds the skill's actual CONTENTS (readSkillSource), not the bare
 *  SKILL.md path (F-069) — so the eval judges the real instructions, not a filename.
 *  Pure + exported for unit-testing. */
export function buildEvalPrompt(skill: Skill): string {
  return [
    `You are evaluating a registered skill using the eval-harness methodology.`,
    `Skill name: ${skill.name}`,
    `Skill type: ${skill.type}`,
    ``,
    `Skill source under test:`,
    `"""`,
    readSkillSource(skill),
    `"""`,
    ``,
    `Assess whether this skill's source is well-formed, unambiguous, and would`,
    `reliably accomplish its stated intent. Apply the eval-harness approach:`,
    `derive the success criteria, reason about edge cases, and judge pass/fail.`,
    ``,
    `END your output with EXACTLY ONE of these lines, verbatim, on its own line:`,
    EVAL_VERDICT_PASS,
    `or`,
    EVAL_VERDICT_FAIL,
  ].join('\n')
}

/** Derive a pass/fail verdict. A machine-readable marker in the agent's final
 *  output wins; otherwise fall back to the terminal run status (done → pass,
 *  any non-done terminal → fail). Pure + exported for unit-testing.
 *
 *  STATUS OF `lastResultText` (F2.W3 decision): the live path does NOT yet wire
 *  it — runSkillTest calls deriveEvalStatus(status) with the terminal run status
 *  only, so today the marker branch is exercised solely by unit tests. The branch
 *  is RESERVED, not dead: capturing the agent's final result text and threading it
 *  here is deferred to F3 (the eval subsystem replaces this shallow self-review
 *  with the real cases+rubric+degraded methodology). Kept now so the protocol +
 *  its tests stay in place for that lift. */
export function deriveEvalStatus(
  terminalRunStatus: string,
  lastResultText?: string,
): 'pass' | 'fail' {
  if (lastResultText != null) {
    if (lastResultText.includes(EVAL_VERDICT_PASS)) return 'pass'
    if (lastResultText.includes(EVAL_VERDICT_FAIL)) return 'fail'
  }
  return terminalRunStatus === 'done' ? 'pass' : 'fail'
}

/** Finalize an eval row: compute regression vs the prior completed baseline and
 *  persist the result. Exported as a seam so tests can drive the result path
 *  directly without a live run. Returns the updated SkillEval. */
export function finalizeSkillEval(
  evalId: string,
  skillId: string,
  newStatus: 'pass' | 'fail',
): SkillEval {
  // Baseline = the most recent completed eval that is NOT this one.
  const baselineRow = skillEvalsDb.latestCompletedSkillEval.get(skillId) as
    | Record<string, unknown>
    | undefined
  const baseline =
    baselineRow && String(baselineRow.id) !== evalId ? rowToSkillEval(baselineRow) : null
  const regression = baseline?.status === 'pass' && newStatus === 'fail'

  skillEvalsDb.updateSkillEvalResult.run({
    id: evalId,
    status: newStatus,
    regression: regression ? 1 : 0,
    baselineEvalId: baseline?.id ?? null,
    completedAt: Date.now(),
  })
  return rowToSkillEval(skillEvalsDb.getSkillEval.get(evalId) as Record<string, unknown>)
}

/** Dispatch a supervised agent run that evaluates the target skill, then records
 *  a pass/fail result + regression flag. Mirrors triggerSkill's lifecycle.
 *
 *  Dispatch-failure degradation: if startRun throws we mark the eval row 'fail'
 *  (with completedAt) and still return its id, so the UI surfaces a failed eval
 *  rather than crashing — the route stays 202 and the failure is visible/durable.
 */
export async function runSkillTest(skillId: string): Promise<{ evalId: string; runId: string }> {
  const row = skillsDb.getSkill.get(skillId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`Skill not found: ${skillId}`)
  const skill = rowToSkill(row)

  const evalId = randomUUID()
  const now = Date.now()

  // Insert the eval row first (status 'pending') so it is durable even if the
  // dispatch below fails.
  skillEvalsDb.insertSkillEval.run({
    id: evalId,
    skillId,
    runId: null,
    status: 'pending',
    regression: 0,
    baselineEvalId: null,
    createdAt: now,
    completedAt: null,
  })

  let run
  try {
    run = await startRun(buildEvalPrompt(skill))
  } catch (e) {
    // Graceful degrade: record a failed eval and surface its id rather than
    // crash. Log so the dispatch failure isn't operationally invisible.
    console.warn(`[skills] runSkillTest dispatch failed for ${skillId}:`, e)
    finalizeSkillEval(evalId, skillId, 'fail')
    return { evalId, runId: '' }
  }

  // Wire the supervised-run completion lifecycle (patch runId, finalize on
  //   terminal, race-backstopped) — shared via run-lifecycle.ts.
  trackSupervisedRun(run.id, {
    onStarted: rid => skillEvalsDb.patchSkillEvalRunId.run(rid, evalId),
    finalize: status => finalizeSkillEval(evalId, skillId, deriveEvalStatus(status)),
  })

  return { evalId, runId: run.id }
}

/** Subscribe to internal eventBus for event-triggered skills. */
export function startEventListener(): void {
  eventBus.onRunUpdate(r => {
    const skills = listSkills().filter(
      s => s.enabled && s.triggerType === 'event' && s.eventTrigger === r.status,
    )
    for (const skill of skills) {
      // E-17: an EVENT-triggered skill run is an AUTONOMOUS org dispatch, and it reaches
      // startRun DIRECTLY (not via startAgentRun), so gate it here — a capped org must
      // stop firing routines. SKIP (no throw): a triggered skill is fire-and-forget.
      const g = budgetGate({})
      if (!g.allowed) {
        console.warn(
          `[skills] event dispatch skipped for ${skill.name}: budget_capped ` +
            `(${g.scope} cap $${g.capUsd}, measured $${g.spentUsd.toFixed(2)}/24h)`,
        )
        continue
      }
      triggerSkill(skill.id, `event:run_update:${r.status}`).catch(err =>
        console.warn(`[skills] event trigger failed for ${skill.name}:`, err),
      )
    }
  })
}

/** Cron loop — fires schedule-triggered skills whose cron expression matches.
 *  Uses node-cron v4. An outer 1-minute heartbeat reconciles the set of active
 *  per-skill cron tasks: it adds tasks for newly-enabled schedule skills with a
 *  valid cron expression, and stops/removes tasks for skills that are no longer
 *  active. Each per-skill task fires on its own cron expression and recurs by
 *  design (a cron schedule is meant to fire repeatedly — tasks are NOT stopped
 *  after their first fire). */
export function startScheduler(): void {
  // Outer heartbeat: every minute re-evaluate which schedule-triggered skills
  // should have a cron task running.
  const activeTasks = new Map<string, ReturnType<typeof cronSchedule>>()

  cronSchedule('* * * * *', () => {
    const skills = listSkills().filter(
      s => s.enabled && s.triggerType === 'schedule' && s.schedule && cronValidate(s.schedule),
    )

    // Remove tasks for skills that are no longer active/valid
    for (const [id, task] of activeTasks) {
      if (!skills.find(s => s.id === id)) {
        task.stop()
        activeTasks.delete(id)
      }
    }

    // Start tasks for newly active skills
    for (const skill of skills) {
      if (activeTasks.has(skill.id) || !skill.schedule) continue
      const task = cronSchedule(skill.schedule, () => {
        // E-17: a SCHEDULE-triggered skill run is an AUTONOMOUS org dispatch that reaches
        // startRun DIRECTLY (not via startAgentRun), so gate it at the cron tick — a capped
        // org must stop firing scheduled routines. SKIP (no throw): a triggered skill is
        // fire-and-forget; the next tick re-consults once spend rolls back under the cap.
        const g = budgetGate({})
        if (!g.allowed) {
          console.warn(
            `[skills] schedule dispatch skipped for ${skill.name}: budget_capped ` +
              `(${g.scope} cap $${g.capUsd}, measured $${g.spentUsd.toFixed(2)}/24h)`,
          )
          return
        }
        fireScheduledSkill(skill.id, 'scheduler').catch(err =>
          console.warn(`[skills] schedule trigger failed for ${skill.name}:`, err),
        )
      })
      activeTasks.set(skill.id, task)
    }
  })
}
