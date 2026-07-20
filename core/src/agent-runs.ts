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
import { claudeDefaultModel } from './config-store.js'
import { startRun } from './supervisor.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { agentRunsDb } from './db.js'
import { budgetGate, BudgetCapError } from './budget-governor.js'
import type { AgentRunTrigger, SubAgentDef } from '@k/shared'

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
  /** Working directory for the run (the scoped project's localPath). Defaults to
   *  the K repo root inside startRun. */
  cwd?: string
  /** Keep the run's stdin open for a warm multi-turn session (D-014 persistent
   *  stdin). Default false = today's one-shot fire-and-forget. Used by the K front
   *  door (k-thread.ts) so a warm interactive session can continue via sendInput. */
  interactive?: boolean
  /** Explicit per-ask model override — wins over the profile default AND the
   *  runtime default (C2 power controls; validated at the route boundary). */
  model?: string
  /** W7a (K-secretary front door ONLY): make the run a RESUMABLE one-shot against a
   *  STABLE, persisted per-thread config dir + cwd (not a fresh worktree + ephemeral
   *  config). Threaded verbatim to startRun. Absent for every other activation.
   *  Continuous Agents W0.3 (D-122): agent-sessions.ts passes `homeDir` (the session's
   *  stable agentSessionPaths base) to generalize the same mechanics to any profile;
   *  absent → the K-secretary path in startRun, byte-identical. */
  persistentSession?: { key: string; sessionId: string; resume: boolean; homeDir?: string }
  /** Continuous Agents A.2 (D-122): per-run awaiting_input idle override, threaded
   *  verbatim to startRun (agent-sessions.ts passes SESSION_IDLE_MS so session idle
   *  demotion is tunable independently of the HITL default). Absent → the
   *  supervisor's INTERACTIVE_IDLE_MS, byte-identical. */
  idleMs?: number
  /** Continuous Agents A.3 (D-127): the run's kind (runs.kind bookkeeping),
   *  threaded verbatim to startRun. Absent → inferred here (and identically in
   *  startRun): persistentSession → 'chat-turn', else 'job'. pipeline-executor
   *  passes 'pipeline-stage' explicitly. Also keys the budget/plan-gate
   *  exemptions below — chat turns are never gated. CAUTION: do NOT combine an
   *  explicit non-chat kind with persistentSession — that combo RE-ARMS both
   *  gates for a session-mechanics run, and a plan-gated profile would then
   *  compose planGate:true into startRun's one-shot-only throw. No production
   *  caller does (session spawns are always interactive:true); documented as a
   *  latent foot-gun (A.3 quality m5). */
  kind?: 'chat-turn' | 'job' | 'pipeline-stage'
  /** Continuous Agents A.3 (D-127): the owning agent_sessions row id, threaded
   *  verbatim to startRun → runs.session_id. Absent for non-session runs. */
  sessionId?: string
  /** SEAMS#2 (b): true when this session dispatch was CAUSED BY AN AGENT — a
   *  relay-delivered profile message (briefing, report-back, agent→agent send)
   *  waking the target. Profile-originated chat-turns ARE budget-gated: the
   *  operator's own conversation stays exempt (they must always reach K to raise
   *  the cap), but autonomous agent↔agent conversation is paid org spend and the
   *  org cap must bound it (spec: "supervision briefings ARE budget-gated").
   *  Absent/false → the pre-existing operator-exempt behavior, byte-identical. */
  profileOriginated?: boolean
  /** H8 (opt-in): start the run's worktree from the source repo's uncommitted
   *  tracked+staged changes instead of clean HEAD. Threaded verbatim to startRun;
   *  default false/absent → byte-identical clean-HEAD behavior. */
  carryWorkingTree?: boolean
  /** D-119 (Pipeline Engine): fork the run's worktree at an explicit base commit
   *  instead of clean HEAD — the per-edge handoff (share-tree/branch/merge) computes
   *  it. Threaded verbatim to startRun, which enforces it is MUTUALLY EXCLUSIVE with
   *  carryWorkingTree. Absent for every non-pipeline activation → unchanged behavior. */
  baseCommit?: string
  /** D-119 (Pipeline Engine, A3): per-STAGE plan-gate override. A pipeline stage can arm
   *  the plan park regardless of the resolved profile's own planGate (a StageDef.planGate).
   *  OR'd with the profile default below; the interactive/persistent-session exemption
   *  still applies. Absent for every non-pipeline activation → the profile default alone
   *  governs (byte-identical). */
  planGate?: boolean
  /** orch-p2 A.5 (Pipeline sub-agents): the resolved worker-bee def to mount into the run's
   *  synthesized config dir. Threaded verbatim to startRun → synthesizeConfigDir. Absent for
   *  every non-pipeline / no-subagent activation → unchanged behavior. */
  subagent?: SubAgentDef | null
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

  // E-17 budget governor: refuse a NEW autonomous/org dispatch when the org OR the
  // scoped project is at its measured cap. INTERACTIVE dispatches and CHAT TURNS are
  // EXEMPT — chat turns are the operator's conversation channel, and the operator must
  // always be able to reach K (or any conversable agent) to raise the cap. A NON-chat
  // 'delegation' dispatch (e.g. the Chief dispatching a lead) IS a paid org dispatch and
  // IS gated. (A.4/D-126: the old operator→Chief caller, k-thread.ts::delegateToChief, is
  // RETIRED — K asks are chat turns and a forced route queues a free mailbox row, so no
  // live askK path catches BudgetCapError anymore; routes/k.ts's 429 mapping survives as
  // a dead-belt.) Thrown BEFORE the tracking-row insert, so a capped dispatch leaves no row.
  // P5 SEAMS minor (BE.7), reworded by A.3 (D-127): the exemption keys on the run's
  // KIND — structurally derived from persistentSession unless explicitly passed —
  // never the caller-supplied trigger string, which is trust-free and no longer
  // exempts by itself (the one 'user-message' site, k-thread.ts / agent-sessions.ts,
  // always dispatches a chat turn, so behavior is unchanged for legitimate callers).
  const kind = opts.kind ?? (opts.persistentSession ? 'chat-turn' : 'job')
  // SEAMS#2 (b): a chat-turn is exempt only as the OPERATOR's conversation
  // channel. A PROFILE-ORIGINATED session wake (relay delivery of an agent
  // message / briefing / report-back) is autonomous paid spend and rides the
  // budget gate like any org dispatch — otherwise agent↔agent conversation
  // would be unmetered and the org cap toothless over it. Non-chat kinds keep
  // the pre-existing rule (gated unless interactive).
  const gated = kind === 'chat-turn' ? opts.profileOriginated === true : !opts.interactive
  if (gated) {
    const g = budgetGate({ projectId: opts.projectId })
    if (!g.allowed) throw new BudgetCapError(g.scope, g.capUsd, g.spentUsd)
  }

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
  //    (its tier's charter/allowlist/MCP/skills). Model precedence: an explicit
  //    per-ask override (opts.model — the C2 power control) wins over the profile's
  //    explicit override, which wins over the operator's runtime Claude default
  //    resolved AT DISPATCH TIME (P5.5 reconciliation — the org no longer pins a
  //    frozen literal). If startRun throws, the 'running' tracking row would leak —
  //    so roll it back to 'failed', log, and re-throw (mirrors dispatchTaskWorkflow).
  let run
  try {
    run = await startRun(prompt, {
      model: opts.model ?? profile.defaultModel ?? claudeDefaultModel(),
      projectId: opts.projectId,
      cwd: opts.cwd,
      profile,
      interactive: opts.interactive,
      idleMs: opts.idleMs,
      persistentSession: opts.persistentSession,
      carryWorkingTree: opts.carryWorkingTree,
      baseCommit: opts.baseCommit,
      // A.3 (D-127): runs.kind + runs.session_id bookkeeping (kind resolved above,
      // alongside the budget gate it also keys).
      kind,
      sessionId: opts.sessionId,
      // E-02 (D-084): tier default — a plan_gate profile plan-gates its org dispatches,
      // but NEVER an interactive dispatch or a chat turn (a session/K conversation
      // composes to the startRun one-shot throw). Mirrors the routes/runs.ts
      // interactive exemption. A.3 (D-127): the exemption keys on the run's KIND
      // (derived from persistentSession above), matching the budget gate.
      // D-119 (A3, A4 NIT-fix): a per-stage opts.planGate is a true OR with the profile
      // default — EITHER arming the plan park. (The prior `??` let opts.planGate:false
      // SUPPRESS a plan_gate profile's gate — a latent footgun the A3 review flagged.) The
      // interactive/chat-turn exemption is preserved.
      planGate: ((opts.planGate === true) || (profile.planGate === true)) && !opts.interactive && kind !== 'chat-turn' ? true : undefined,
      // A.5: thread the resolved worker-bee def to synthesizeConfigDir (via startRun).
      subagent: opts.subagent,
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
