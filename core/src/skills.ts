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

import { randomUUID } from 'crypto'
import { schedule as cronSchedule, validate as cronValidate } from 'node-cron'
import type { Skill, CreateSkill, SkillEval } from '@k/shared'
import { db, skillsDb, skillEvalsDb } from './db.js'
import { startRun } from './supervisor.js'
import { eventBus } from './events.js'
import { trackSupervisedRun } from './run-lifecycle.js'

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
    enabled: 1,
    createdAt: now,
  })
  return rowToSkill(skillsDb.getSkill.get(id) as Record<string, unknown>)
}

export async function triggerSkill(
  skillId: string,
  triggeredBy: string,
): Promise<{ skillRunId: string; runId: string }> {
  const row = skillsDb.getSkill.get(skillId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`Skill not found: ${skillId}`)
  const skill = rowToSkill(row)

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

  // Launch the underlying run
  const run = await startRun(skill.source)

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
 *  verdict line. Pure + exported for unit-testing. */
export function buildEvalPrompt(skill: Skill): string {
  return [
    `You are evaluating a registered skill using the eval-harness methodology.`,
    `Skill name: ${skill.name}`,
    `Skill type: ${skill.type}`,
    ``,
    `Skill source under test:`,
    `"""`,
    skill.source,
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
 *  any non-done terminal → fail). Pure + exported for unit-testing. */
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
        triggerSkill(skill.id, 'scheduler').catch(err =>
          console.warn(`[skills] schedule trigger failed for ${skill.name}:`, err),
        )
      })
      activeTasks.set(skill.id, task)
    }
  })
}
