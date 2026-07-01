/**
 * Agent-run activation — `startAgentRun`, the single primitive that activates a
 * durable profile into a bounded supervised run (bible §03, D-023). It generalizes
 * today's `startRun`: instead of always dispatching the hardcoded orchestrator, it
 * resolves the named profile and dispatches the run under THAT profile's tier, so
 * the config synthesizer mounts the profile's charter/allowlist/MCP/skills.
 *
 * It rides the shared run-lifecycle seam (run-lifecycle.ts::trackSupervisedRun),
 * exactly like workflows.ts::dispatchTaskWorkflow and skills.ts::triggerSkill:
 *   1. insert the `agent_runs` tracking row (status 'running', no runId yet);
 *   2. `await startRun(...)` under the resolved profile;
 *   3. on the SUCCESS path, wire the completion lifecycle (patch runId, finalize on
 *      terminal, race-backstopped).
 * The DISPATCH-FAILURE degrade path is owned HERE (the try/catch around startRun):
 * because step 1 locks the tracking row to 'running' BEFORE the await, a throw must
 * ROLL THAT BACK — we finalize the row 'failed' and re-throw so the caller learns the
 * dispatch failed rather than leaking a forever-'running' row (the run-lifecycle
 * seam only handles the success path after startRun returns).
 *
 * Lives in its own module (not profiles.ts) to avoid an import cycle: it imports both
 * profiles.ts (getProfile) and supervisor.ts (startRun), and supervisor.ts imports
 * profiles.ts — so hanging startAgentRun off supervisor or profiles would cycle.
 */

import { randomUUID } from 'crypto'
import { getProfile } from './profiles.js'
import { startRun } from './supervisor.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { agentRunsDb } from './db.js'
import type { AgentRunTrigger } from '@k/shared'

/** How a profile was activated (bible §03). The canonical union lives in @k/shared
 *  (AgentRunTriggerSchema); re-exported here so importers keep resolving it from
 *  './agent-runs.js' and the two never drift. */
export type { AgentRunTrigger }

export interface StartAgentRunOptions {
  trigger: AgentRunTrigger
  /** The task/instruction seeding the run (the `-p` user turn). One of goal|thread
   *  is required; the profile's charter is injected as the system prompt separately. */
  goal?: string
  /** Alias for goal — a conversational seed (bible's "goal | thread"). */
  thread?: string
  projectId?: string
  workflowId?: string
}

/** Map a terminal run status to an agent_runs status. done → completed; any other
 *  terminal status → failed. Pure + exported for unit-testing (mirrors
 *  deriveWorkflowStatus). */
export function deriveAgentRunStatus(terminalRunStatus: string): 'completed' | 'failed' {
  return terminalRunStatus === 'done' ? 'completed' : 'failed'
}

/**
 * Activate `profileId` into a supervised run seeded with `goal`/`thread`, tracked in
 * `agent_runs`. Throws if the profile is unknown or neither goal nor thread is given
 * (validate-before-mutate). Re-throws a dispatch failure after finalizing the
 * tracking row 'failed'. Returns the tracking-row id + the run id on success.
 */
export async function startAgentRun(
  profileId: string,
  opts: StartAgentRunOptions,
): Promise<{ agentRunId: string; runId: string }> {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`Agent profile not found: ${profileId}`)

  const prompt = opts.goal ?? opts.thread
  if (!prompt) throw new Error('startAgentRun requires a goal or thread')

  // 1. Insert the tracking row (status 'running', no runId yet).
  const agentRunId = randomUUID()
  const now = Date.now()
  agentRunsDb.insertAgentRun.run({
    id: agentRunId,
    profileId,
    runId: null,
    trigger: opts.trigger,
    goal: prompt,
    projectId: opts.projectId ?? null,
    workflowId: opts.workflowId ?? null,
    status: 'running',
    createdAt: now,
    completedAt: null,
  })

  // 2. Dispatch under the resolved profile. The profile drives config synthesis
  //    (its tier's charter/allowlist/MCP/skills) and its defaultModel forces claude
  //    at that model. If startRun throws, the 'running' tracking row would leak — so
  //    roll it back to 'failed', log, and re-throw (mirrors dispatchTaskWorkflow).
  let run
  try {
    run = await startRun(prompt, {
      model: profile.defaultModel,
      projectId: opts.projectId,
      profile,
    })
  } catch (e) {
    agentRunsDb.updateAgentRunStatus.run('failed', Date.now(), agentRunId)
    console.warn(`[agent-runs] startAgentRun dispatch failed for profile ${profileId}:`, e)
    throw e
  }

  // 3. Wire the supervised-run completion lifecycle (patch runId, finalize on
  //    terminal, race-backstopped) — shared via run-lifecycle.ts.
  trackSupervisedRun(run.id, {
    onStarted: rid => agentRunsDb.patchAgentRunId.run(rid, agentRunId),
    finalize: status =>
      agentRunsDb.updateAgentRunStatus.run(deriveAgentRunStatus(status), Date.now(), agentRunId),
  })

  return { agentRunId, runId: run.id }
}
