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
import type { Skill, CreateSkill } from '@k/shared'
import { db, skillsDb } from './db.js'
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
