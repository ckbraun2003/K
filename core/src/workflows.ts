/**
 * Workflows module — supervised delegation runs over a batch of selected todos.
 *
 * Provides:
 *   - buildDelegationPrompt: pure prompt-builder (the orchestrator of the harness
 *     delegation loop, spawning its own subagents)
 *   - dispatchTaskWorkflow: lifecycle — load + lock tasks, insert a workflow_run,
 *     start one supervised run, finalize the row when the run terminates
 *   - finalizeWorkflowRun / deriveWorkflowStatus: pure seams for the finalize path
 */

import { randomUUID } from 'crypto'
import type { Project, ProjectTask } from '@k/shared'
import { projectTasksDb, workflowRunsDb, runsDb } from './db.js'
import { startRun } from './supervisor.js'
import { eventBus } from './events.js'

// Terminal run statuses — same set runSkillTest uses to finalize.
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])

/** Thrown when a requested taskId is missing or not scoped to this project. The
 *  route discriminates on this type (instanceof) to translate it to a 400. */
export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task not found in project: ${taskId}`)
    this.name = 'TaskNotFoundError'
  }
}

/** DB row → ProjectTask shape. Local to keep modules clean (rowToTask is a
 *  private helper in routes/projects.ts; we don't import from the route). */
function rowToTask(r: Record<string, unknown>): ProjectTask {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    status: r.status as ProjectTask['status'],
    createdAt: Number(r.created_at),
    completedAt: r.completed_at != null ? Number(r.completed_at) : null,
    issueNumber: r.issue_number != null ? Number(r.issue_number) : null,
    issueUrl: r.issue_url != null ? String(r.issue_url) : null,
    issueState: r.issue_state != null ? String(r.issue_state) : null,
  }
}

/** Build the delegation prompt: instruct the agent to act as the orchestrator of
 *  the harness delegation loop over the selected todos. Pure + exported for
 *  unit-testing — deterministic (no Date.now/random). */
export function buildDelegationPrompt(tasks: ProjectTask[]): string {
  if (tasks.length === 0) throw new Error('buildDelegationPrompt requires at least one task')
  const checklist = tasks.map((t, i) => `${i + 1}. [ ] ${t.title}`).join('\n')
  return [
    `You are the orchestrator of the harness delegation loop. Address the following`,
    `selected todos as a single coordinated batch:`,
    ``,
    checklist,
    ``,
    `Run the delegation loop: implementer → spec-review → quality-review → you`,
    `(the orchestrator) apply fixes. Spawn your own subagents for each role — do not`,
    `do all the work in one context. Run a review agent for every wave, no`,
    `exceptions.`,
    ``,
    `Report progress through the workflow status-write tools as you go: call`,
    `workflow_step_set for each todo, loop phase, review, and the CI gate (marking`,
    `it in_progress / done / blocked / failed), and workflow_status_set for the`,
    `overall run — the operator watches this checklist, not your transcript.`,
    ``,
    `Produce ONE reviewable commit / a single PR for the whole batch — do not open`,
    `a separate PR per todo.`,
    ``,
    `Apply changes via PR only — NEVER push to a default branch. Branch off the`,
    `default branch before committing.`,
  ].join('\n')
}

/** Map a terminal run status to a workflow_run status. done → completed; any
 *  other terminal status → failed. Pure + exported for unit-testing. */
export function deriveWorkflowStatus(terminalRunStatus: string): 'completed' | 'failed' {
  return terminalRunStatus === 'done' ? 'completed' : 'failed'
}

/** Finalize a workflow_run row to a terminal status. Exported as a seam so tests
 *  can drive the result path directly without a live run. */
export function finalizeWorkflowRun(workflowRunId: string, terminalRunStatus: string): void {
  workflowRunsDb.updateWorkflowRunStatus.run(
    deriveWorkflowStatus(terminalRunStatus),
    Date.now(),
    workflowRunId,
  )
}

/** Dispatch ONE supervised agent run that addresses the selected todos via the
 *  harness delegation loop, then finalizes the workflow_run when the run reaches
 *  a terminal status. Mirrors triggerSkill / runSkillTest's lifecycle.
 *
 *  Throws if any taskId is missing or not in this project (the route translates
 *  the Error to a 400). Selected todos flip to 'in_progress' but are NOT
 *  auto-marked 'done' — the agent's PR decides completion.
 */
export async function dispatchTaskWorkflow(
  project: Project,
  taskIds: string[],
): Promise<{ workflowRunId: string; runId: string }> {
  // 1. Load every task, scoped to this project. Any miss → throw (route → 400).
  const tasks: ProjectTask[] = []
  for (const taskId of taskIds) {
    const row = projectTasksDb.getProjectTask.get(taskId, project.id) as
      | Record<string, unknown>
      | undefined
    if (!row) throw new TaskNotFoundError(taskId)
    tasks.push(rowToTask(row))
  }

  // 2. Lock the selected tasks as in_progress.
  for (const task of tasks) {
    projectTasksDb.updateProjectTaskStatus.run({
      id: task.id,
      projectId: project.id,
      status: 'in_progress',
      completedAt: null,
    })
  }

  // 3. Insert the workflow_run row (status 'running', no runId yet).
  const workflowRunId = randomUUID()
  const now = Date.now()
  workflowRunsDb.insertWorkflowRun.run({
    id: workflowRunId,
    projectId: project.id,
    runId: null,
    taskIds: JSON.stringify(taskIds),
    mode: 'combined',
    status: 'running',
    createdAt: now,
    completedAt: null,
  })

  // 4. Launch the supervised run in the project's repo. If startRun throws, the
  //    'running' workflow_run row and the in_progress task locks would leak — so
  //    on failure we finalize the row 'failed', revert each task to 'open', log,
  //    and re-throw (the route surfaces a 500). Mirrors runSkillTest's degrade.
  let run
  try {
    run = await startRun(buildDelegationPrompt(tasks), {
      cwd: project.localPath,
      projectId: project.id,
    })
  } catch (e) {
    workflowRunsDb.updateWorkflowRunStatus.run('failed', Date.now(), workflowRunId)
    for (const task of tasks) {
      projectTasksDb.updateProjectTaskStatus.run({
        id: task.id,
        projectId: project.id,
        status: 'open',
        completedAt: null,
      })
    }
    console.warn('[workflows] startRun dispatch failed:', e)
    throw e
  }

  // 5. Patch the runId back onto the workflow_run.
  workflowRunsDb.patchWorkflowRunId.run(run.id, workflowRunId)

  // 6. Finalize when the run terminates. unsub() runs BEFORE the finalize write
  //    so a duplicate terminal event can't re-finalize the row.
  const unsub = eventBus.onRunUpdate(r => {
    if (r.id !== run.id || !TERMINAL.has(r.status)) return
    unsub()
    finalizeWorkflowRun(workflowRunId, r.status)
  })

  // Backstop the await/subscribe race: if the run already reached a terminal
  // state before we subscribed, finalize now instead of leaking a 'running' row.
  const current = runsDb.getRun.get(run.id) as { status?: string } | undefined
  if (current?.status != null && TERMINAL.has(current.status)) {
    unsub()
    // Re-read the workflow_run: the subscriber may have already finalized it.
    // Only finalize if it's still 'running' so we don't double-write.
    const wfRow = workflowRunsDb.getWorkflowRun.get(workflowRunId) as { status?: string } | undefined
    if (wfRow?.status === 'running') {
      finalizeWorkflowRun(workflowRunId, current.status)
    }
  }

  // 7. Do NOT auto-mark todos done.
  return { workflowRunId, runId: run.id }
}
