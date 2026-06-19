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
import { db, skillsDb, skillEvalsDb, runsDb } from './db.js'
import { startRun } from './supervisor.js'
import { eventBus } from './events.js'

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

  // Patch the runId back onto the skill_run
  patchSkillRunId.run(run.id, skillRunId)

  // Watch for run completion and update skill_run status
  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== run.id) return
    if (
      r.status === 'done' ||
      r.status === 'error' ||
      r.status === 'killed' ||
      r.status === 'interrupted'
    ) {
      const srStatus = r.status === 'done' ? 'completed' : 'failed'
      skillsDb.updateSkillRunStatus.run(srStatus, Date.now(), skillRunId)
      unsub()
    }
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

  skillEvalsDb.patchSkillEvalRunId.run(run.id, evalId)

  // Watch for run completion; derive verdict from the terminal status (the
  // marker branch in deriveEvalStatus is exercised by unit tests / future
  // enrichment — the live path only has the run status here). unsub() runs
  // BEFORE finalize so a duplicate terminal event can't re-finalize the row.
  const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])
  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== run.id || !TERMINAL.has(r.status)) return
    unsub()
    finalizeSkillEval(evalId, skillId, deriveEvalStatus(r.status))
  })

  // Backstop the await/subscribe race: if the run already reached a terminal
  // state before we subscribed, finalize now instead of leaking a 'pending' row.
  const current = runsDb.getRun.get(run.id) as { status?: string } | undefined
  if (current?.status != null && TERMINAL.has(current.status)) {
    unsub()
    finalizeSkillEval(evalId, skillId, deriveEvalStatus(current.status))
  }

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
