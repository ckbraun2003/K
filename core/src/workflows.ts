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
import { projectWorkItemsDb, workflowRunsDb, workflowStepsDb, rowToProjectTask } from './db.js'
import { startRun } from './supervisor.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { eventBus } from './events.js'

/** Thrown when a requested taskId is missing or not scoped to this project. The
 *  route discriminates on this type (instanceof) to translate it to a 400. */
export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task not found in project: ${taskId}`)
    this.name = 'TaskNotFoundError'
  }
}

/** The token a workflow prompt scaffold carries where the numbered todo checklist is
 *  rendered in at dispatch (renderWorkflowPrompt). */
export const CHECKLIST_TOKEN = '{{CHECKLIST}}'

/** The built-in code-wave delegation scaffold: the harness delegation-loop prompt with
 *  a `{{CHECKLIST}}` token where the numbered todo list is rendered. This is the seed
 *  scaffold for the `code-wave` NamedWorkflow (workflow-defs.ts) and the template
 *  buildDelegationPrompt renders — kept as an array-join so its content stays
 *  byte-identical to the pre-P5.3b inline builder. */
export const CODE_WAVE_SCAFFOLD = [
  `You are the orchestrator of the harness delegation loop. Address the following`,
  `selected todos as a single coordinated batch:`,
  ``,
  `{{CHECKLIST}}`,
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

/** Render a workflow prompt from a scaffold + the selected checklist items: replace
 *  the `{{CHECKLIST}}` token with the numbered list. `tasks` is any readonly list of
 *  `{ title }` (a full `ProjectTask` satisfies it; a Chief→lead dispatch passes a
 *  single synthetic `{ title: objective }` — chief-dispatch.ts). Pure + exported for
 *  unit-testing — deterministic (no Date.now/random). */
export function renderWorkflowPrompt(scaffold: string, tasks: readonly { title: string }[]): string {
  if (tasks.length === 0) throw new Error('a workflow prompt requires at least one task')
  const checklist = tasks.map((t, i) => `${i + 1}. [ ] ${t.title}`).join('\n')
  // replaceAll so an operator-edited scaffold with more than one token renders fully; the
  // function replacer inserts `$`-bearing task titles literally (no $-pattern interpretation).
  return scaffold.replaceAll(CHECKLIST_TOKEN, () => checklist)
}

/** Build the delegation prompt: instruct the agent to act as the orchestrator of
 *  the harness delegation loop over the selected todos. Pure + exported for
 *  unit-testing — deterministic (no Date.now/random). Output is byte-identical to the
 *  pre-P5.3b inline builder — it renders the built-in CODE_WAVE_SCAFFOLD. */
export function buildDelegationPrompt(tasks: ProjectTask[]): string {
  return renderWorkflowPrompt(CODE_WAVE_SCAFFOLD, tasks)
}

/** Map a terminal run status to a workflow_run status. done → completed; any
 *  other terminal status → failed. Pure + exported for unit-testing. */
export function deriveWorkflowStatus(terminalRunStatus: string): 'completed' | 'failed' {
  return terminalRunStatus === 'done' ? 'completed' : 'failed'
}

/** Finalize a workflow_run row to a terminal status. Exported as a seam so tests
 *  can drive the result path directly without a live run.
 *
 *  AUTHORITY MODEL: this is the AUTHORITATIVE terminal write. It overwrites any
 *  overall status the agent set mid-run via the `workflow_status_set` tool — that
 *  write is a mid-run advisory; at termination the supervisor re-derives the
 *  status from the actual run outcome (done→completed, else→failed) and wins
 *  (campaign-s2 S2-013). It is last-writer-wins with NO terminal lock of its own
 *  (S2-015), so a duplicate terminal event re-finalizing is harmless — the
 *  run-lifecycle seam's finalize-once latch makes that a non-issue in practice.
 *
 *  F-072: after writing the row's terminal status, RECONCILE any lingering non-terminal
 *  child step (still 'pending'/'in_progress') to 'blocked', so the checklist can never
 *  contradict the finalized row (a step stuck 'in_progress' under a 'completed' run). An
 *  unfinished step becomes 'blocked' — honest "not resolved", never a false 'done'. */
export function finalizeWorkflowRun(workflowRunId: string, terminalRunStatus: string): void {
  const status = deriveWorkflowStatus(terminalRunStatus)
  workflowRunsDb.updateWorkflowRunStatus.run(status, Date.now(), workflowRunId)
  workflowStepsDb.reconcileNonTerminalSteps.run({ workflowRunId, updatedAt: Date.now() })

  // F-076: emit a transient completion SIGNAL the UI surfaces as a nudge to REVIEW +
  // CLOSE the tasks this workflow locked to 'in_progress'. dispatchTaskWorkflow never
  // auto-closes them (D-012 — the PR/operator decides), and finalize touches no task, so
  // without this signal they linger 'in_progress' with no operator cue. Only for a TASK
  // workflow (non-empty task_ids); a lead workflow run (chief-dispatch seedLeadWorkflowRun,
  // task_ids='[]') has no tasks to nudge, so it broadcasts nothing. Best-effort: a broadcast
  // failure must never break the authoritative finalize write above.
  try {
    const row = workflowRunsDb.getWorkflowRun.get(workflowRunId) as
      | { project_id?: string | null; task_ids?: string | null }
      | undefined
    if (!row?.project_id) return
    let taskIds: string[] = []
    try {
      const parsed = JSON.parse(row.task_ids ?? '[]')
      if (Array.isArray(parsed)) taskIds = parsed.map(String)
    } catch {
      /* malformed task_ids → no nudge */
    }
    if (taskIds.length > 0) {
      eventBus.broadcast({
        type: 'workflow_complete',
        workflowRunId,
        projectId: String(row.project_id),
        status,
        taskIds,
      })
    }
  } catch (err) {
    console.warn('[workflows] workflow_complete broadcast failed:', (err as Error).message)
  }
}

/** Dispatch ONE supervised agent run that addresses the selected todos via the
 *  harness delegation loop, then finalizes the workflow_run when the run reaches
 *  a terminal status. Mirrors triggerSkill / runSkillTest's lifecycle.
 *
 *  Throws if any taskId is missing or not in this project (the route translates
 *  the Error to a 400). Selected todos flip to 'in_progress' but are NOT
 *  auto-marked 'done' — the agent's PR decides completion.
 *
 *  `opts.scaffold` is an alternate NamedWorkflow prompt scaffold (C2 "Run this
 *  workflow") rendered through the same renderWorkflowPrompt seam; omitted = the
 *  built-in CODE_WAVE_SCAFFOLD, byte-identical to the pre-C2 buildDelegationPrompt
 *  path (which stays exported for its own tests/callers). `opts.workflowId` records
 *  WHICH NamedWorkflow template drove the run on the workflow_run row (F-074) — omitted
 *  = a default code-wave dispatch (stored NULL).
 */
export async function dispatchTaskWorkflow(
  project: Project,
  taskIds: string[],
  opts: { scaffold?: string; workflowId?: string } = {},
): Promise<{ workflowRunId: string; runId: string }> {
  // 0. Reject an empty dispatch up-front — validate-before-mutate, mirroring the
  //    step-1 TaskNotFound guard. Without this, steps 1+2 no-op over the empty
  //    list, step 3 inserts the workflow_run row ('running'), then step 4's
  //    renderWorkflowPrompt(…, []) throws inside the try and the catch finalizes
  //    that row to 'failed' instead of deleting it — leaving an orphaned row from
  //    what should be a pure input rejection.
  if (taskIds.length === 0) {
    throw new Error('dispatchTaskWorkflow requires at least one task')
  }

  // 1. Load every task, scoped to this project. Any miss → throw (route → 400).
  const tasks: ProjectTask[] = []
  for (const taskId of taskIds) {
    const row = projectWorkItemsDb.getProjectTask.get(taskId, project.id) as
      | Record<string, unknown>
      | undefined
    if (!row) throw new TaskNotFoundError(taskId)
    tasks.push(rowToProjectTask(row))
  }

  // 2. Lock the selected tasks as in_progress.
  for (const task of tasks) {
    projectWorkItemsDb.updateProjectTaskStatus.run({
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
    workflowId: opts.workflowId ?? null,
    status: 'running',
    createdAt: now,
    completedAt: null,
  })

  // 4. Launch the supervised run in the project's repo. If startRun throws, the
  //    'running' workflow_run row and the in_progress task locks would leak — so
  //    on failure we finalize the row 'failed', restore each task to the prior
  //    (status, completed_at) it carried before step 2's lock — captured in the
  //    `tasks` objects (rowToProjectTask runs before the flip), so a selected 'done'
  //    task stays done instead of being clobbered to 'open' — log, and re-throw
  //    (the route surfaces a 500). Mirrors runSkillTest's degrade.
  let run
  try {
    run = await startRun(renderWorkflowPrompt(opts.scaffold ?? CODE_WAVE_SCAFFOLD, tasks), {
      cwd: project.localPath,
      projectId: project.id,
    })
  } catch (e) {
    workflowRunsDb.updateWorkflowRunStatus.run('failed', Date.now(), workflowRunId)
    for (const task of tasks) {
      projectWorkItemsDb.updateProjectTaskStatus.run({
        id: task.id,
        projectId: project.id,
        status: task.status,
        completedAt: task.completedAt,
      })
    }
    console.warn('[workflows] startRun dispatch failed:', e)
    throw e
  }

  // 5. Wire the supervised-run completion lifecycle (patch runId, finalize on
  //    terminal, race-backstopped) — shared via run-lifecycle.ts.
  trackSupervisedRun(run.id, {
    onStarted: rid => workflowRunsDb.patchWorkflowRunId.run(rid, workflowRunId),
    finalize: status => finalizeWorkflowRun(workflowRunId, status),
  })

  // 7. Do NOT auto-mark todos done.
  return { workflowRunId, runId: run.id }
}
