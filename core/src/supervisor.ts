/**
 * Agent Supervisor — wraps the Claude Code CLI as a supervised subprocess.
 *
 * startRun(prompt, opts):
 *   1. Creates an isolated git worktree (so agents never touch main)
 *   2. Spawns: claude -p <prompt> --output-format stream-json --verbose
 *   3. Parses each NDJSON line into AgentEvent and emits through EventBus
 *   4. Accumulates token/cost usage; emits run_update on completion
 *
 * kill(runId): terminates the child process gracefully (SIGTERM → SIGKILL)
 */

import { execa } from 'execa'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { AgentEventSchema, type AgentEvent, type Run, type AgentProfile } from '@k/shared'
import { eventBus } from './events.js'
import { db, runsDb, projectsDb } from './db.js'
import { route } from './router.js'
import { resolvePermissionMode } from './claude-args.js'
import { getProvider, parseClaudeLine } from './providers.js'
import { matchProjectByCwd, type ProjectPathRow } from './project-match.js'
import { synthesizeConfigDir, pruneOrphanAgentRuns, type SynthesizedConfig } from './agent-config.js'
import { DEFAULT_PROFILE } from './profiles.js'
import { TERMINAL_RUN_STATUSES } from './run-lifecycle.js'

const PERMISSION_MODE = resolvePermissionMode(process.env.RUN_PERMISSION_MODE)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// core/src/* and core/dist/* are both two levels below the repo root
export const REPO_ROOT = path.join(__dirname, '../../')
const WORKTREES_DIR = path.join(__dirname, '../../.worktrees')

fs.mkdirSync(WORKTREES_DIR, { recursive: true })

// Active processes keyed by runId — minimal interface to avoid execa generic
// variance. `stdin`/`interactive` are populated for interactive runs so
// sendInput/endSession can write turns / close the session.
type ActiveProc = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kill: (...args: any[]) => any
  stdin?: NodeJS.WritableStream | null
  interactive: boolean
}
const activeProcesses = new Map<string, ActiveProc>()

// Runs terminated by the operator — exit codes alone can't distinguish a kill
// (non-zero exit) from a genuine agent failure
const killedRuns = new Set<string>()

// Pending SIGKILL-escalation timers keyed by runId, so a killed-then-exited run
// clears its timer instead of leaving a dangling 3s handle. Cleared in the
// run-completion path alongside activeProcesses.delete().
const killTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Pending fallback-SIGTERM timers armed by endSession (for a process that ignores
// stdin EOF), keyed by runId. Tracked like killTimers so a clean exit clears the
// handle instead of leaving a dangling 4s timer holding the proc reference.
const endTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Per-run monotonic event sequence. Held module-side (not just in runAgent's
// closure) so sendInput can emit a synthetic operator-turn event with a correct,
// non-colliding seq while the run is paused at awaiting_input.
const seqCounters = new Map<string, number>()
function nextSeq(runId: string): number {
  const n = seqCounters.get(runId) ?? 0
  seqCounters.set(runId, n + 1)
  return n
}

// Idle timers for interactive runs parked at awaiting_input — if the operator
// never answers, gracefully end the session so the worktree isn't held forever.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const INTERACTIVE_IDLE_MS = Number(process.env.INTERACTIVE_IDLE_MS) || 10 * 60 * 1000

function clearIdleTimer(runId: string) {
  const t = idleTimers.get(runId)
  if (t) { clearTimeout(t); idleTimers.delete(runId) }
}

/** The stdin envelope claude accepts for one operator turn in stream-json input
 *  mode (verified live: content as a bare string is accepted). */
function userTurnEnvelope(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

// Atomic guard for sendInput's double-send race: flip awaiting_input → running in a
// single conditional UPDATE so only one caller can consume a parked turn. A second
// (stale/concurrent) caller sees changes===0 because the row is already 'running'.
const claimAwaitingTurn = db.prepare(
  `UPDATE runs SET status = 'running' WHERE id = ? AND status = 'awaiting_input'`,
)

export type StartRunOptions = {
  cwd?: string
  model?: string
  preferLocal?: boolean
  maxCostUsd?: number
  projectId?: string
  /** Keep stdin open for multi-turn HITL (claude only). Default false → today's
   *  one-shot fire-and-forget run. */
  interactive?: boolean
  /** The agent profile whose tier drives config synthesis (charter, allowlist, MCP,
   *  skills). Defaults to DEFAULT_PROFILE (orchestrator) so every existing caller is
   *  unchanged; startAgentRun passes the resolved profile so a run gets ITS tier's
   *  config, not the orchestrator's. Ignored for ollama runs (no config synthesis). */
  profile?: AgentProfile
}

export async function startRun(prompt: string, opts: StartRunOptions = {}): Promise<Run> {
  // An explicitly-named model is always a Claude model id (validated at the route
  // boundary), so it overrides any local-model preference — never route an
  // explicit `claude-*` id to `ollama run <id>`.
  // An explicit model forces claude; the cost branch in route() is meaningless
  // (and could mis-select ollama for a claude-* id), so neutralize maxCostUsd too.
  const routeResult = route({ prompt, preferLocal: opts.model ? false : opts.preferLocal, maxCostUsd: opts.model ? undefined : opts.maxCostUsd })
  const runId = uuid()
  const cwd = opts.cwd ?? REPO_ROOT
  const worktreePath = path.join(WORKTREES_DIR, runId)
  const now = Date.now()

  // Infer project association from explicit opt or cwd (always use original cwd, never worktree path)
  const projectId = opts.projectId
    ?? matchProjectByCwd(cwd, projectsDb.listProjects.all() as ProjectPathRow[])
    ?? undefined

  const run: Run = {
    id: runId,
    prompt,
    cwd,
    worktree: worktreePath,
    status: 'queued',
    provider: routeResult.provider,
    model: opts.model ?? routeResult.model,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    projectId,
    createdAt: now,
  }

  // Insert the run row
  runsDb.insertRun.run({
    id: run.id,
    prompt: run.prompt,
    cwd: run.cwd,
    worktree: run.worktree ?? null,
    status: run.status,
    provider: run.provider,
    model: run.model,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costUsd: run.costUsd,
    projectId: run.projectId ?? null,
    createdAt: run.createdAt,
  })

  // Interactive (multi-turn stdin) is claude-only; an interactive request that
  // routes to ollama silently falls back to a one-shot local run.
  const interactive = !!opts.interactive && routeResult.provider === 'claude'

  // Emit initial status event (starts this run's seq counter at 0)
  seqCounters.set(runId, 0)
  emitStatusEvent(runId, 'queued', nextSeq(runId), now)
  eventBus.emitRunUpdate(run)

  // Try to create a worktree; fall back to cwd if git isn't set up
  let effectiveCwd = cwd
  try {
    // Only create worktree if cwd is inside a git repo
    await execa('git', ['-C', cwd, 'rev-parse', '--git-dir'], { reject: true })
    await execa('git', ['-C', cwd, 'worktree', 'add', '--detach', worktreePath], { reject: true })
    effectiveCwd = worktreePath
  } catch {
    // Not a git repo or worktree failed — run in cwd directly
    effectiveCwd = cwd
    run.worktree = undefined
    runsDb.clearRunWorktree.run(run.id)
  }

  const inWorktree = effectiveCwd === worktreePath

  // Launch in background — don't await. The profile (default: orchestrator) drives
  // per-tier config synthesis inside runAgent.
  void runAgent(run, prompt, effectiveCwd, inWorktree, interactive, opts.profile ?? DEFAULT_PROFILE)

  return run
}

export function kill(runId: string): boolean {
  const proc = activeProcesses.get(runId)
  if (!proc) return false
  killedRuns.add(runId)
  proc.kill('SIGTERM')
  // Escalate to SIGKILL if the process ignores SIGTERM. Store the handle so the
  // completion path can clear it — otherwise a clean exit leaves a dangling 3s
  // timer holding the proc reference.
  const timer = setTimeout(() => {
    killTimers.delete(runId)
    if (activeProcesses.has(runId)) proc.kill('SIGKILL')
  }, 3000)
  killTimers.set(runId, timer)
  return true
}

/** Forget a run's process + clear any pending SIGKILL-escalation / idle timers and
 *  its seq counter. Called once on terminal completion. */
function clearRunTracking(runId: string) {
  activeProcesses.delete(runId)
  const timer = killTimers.get(runId)
  if (timer) {
    clearTimeout(timer)
    killTimers.delete(runId)
  }
  const endTimer = endTimers.get(runId)
  if (endTimer) {
    clearTimeout(endTimer)
    endTimers.delete(runId)
  }
  clearIdleTimer(runId)
  seqCounters.delete(runId)
  endingRuns.delete(runId)
}

// ── Private ──────────────────────────────────────────────────────────────────

async function removeWorktree(run: Run) {
  if (run.worktree && fs.existsSync(run.worktree)) {
    try {
      await execa('git', ['-C', run.cwd, 'worktree', 'remove', '--force', run.worktree])
    } catch { /* best-effort cleanup */ }
  }
}

// ── Crash recovery (boot sweep) ────────────────────────────────────────────────

/**
 * Flip every `running`/`queued`/`awaiting_input` run to the terminal `interrupted`
 * status and null its worktree column. At boot these statuses are necessarily stale
 * — no in-flight run (including an interactive session parked on stdin) survives a
 * process restart — so leaving them inflates the activeRuns metric forever. Pure DB
 * mutation (no FS/git); takes the DB handle so it's unit-testable against a temp DB.
 * Returns the number of rows reconciled.
 */
export function reconcileStaleRuns(d: import('better-sqlite3').Database = db): number {
  const res = d
    .prepare(
      `UPDATE runs SET status = 'interrupted', worktree = NULL, ended_at = ?
       WHERE status IN ('running', 'queued', 'awaiting_input')`,
    )
    .run(Date.now())
  return res.changes
}

/**
 * Flip every `running` agent_runs tracking row (a profile "activation") to terminal
 * `failed`. At boot these are necessarily stale: the `trackSupervisedRun` subscriber
 * that finalizes an activation row does NOT survive a process restart, so a crash
 * mid-activation leaves the row `running` forever. This is not just a cosmetic metric
 * leak — the Chief autonomous-wake already-running guard (chief-wake.ts Guard B) reads
 * a `running` chief activation as "the Chief is busy" and would then NEVER wake again
 * while an orphaned row lingers. Mirrors reconcileStaleRuns (pure DB mutation; takes
 * the handle for unit-testing). Returns the number of rows reconciled.
 */
export function reconcileStaleActivations(d: import('better-sqlite3').Database = db): number {
  const res = d
    .prepare(`UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE status = 'running'`)
    .run(Date.now())
  return res.changes
}

export function reconcileOrphanedActivations(d: import('better-sqlite3').Database = db): number {
  const now = Date.now()
  // agent_runs stuck 'running' whose LINKED run is already terminal — the precise safety net
  // for a child that exited mid-dispatch (the run finished, the tracking subscriber died with
  // the child). Derive the activation status from the run's terminal status (done → completed,
  // any other terminal → failed) — strictly more correct than the blanket reconcileStaleActivations
  // this runs BEFORE, so a mid-dispatch-COMPLETED lead becomes 'completed', not clobbered to 'failed'.
  // Terminal set mirrors run-lifecycle.ts::TERMINAL_RUN_STATUSES.
  const rows = d.prepare(
    `SELECT ar.id AS id, r.status AS run_status FROM agent_runs ar JOIN runs r ON r.id = ar.run_id
      WHERE ar.status = 'running' AND r.status IN ('done','error','killed','interrupted')`
  ).all() as Array<{ id: string; run_status: string }>
  const upd = d.prepare(`UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ? AND status = 'running'`)
  let n = 0
  for (const row of rows) n += upd.run(row.run_status === 'done' ? 'completed' : 'failed', now, row.id).changes
  return n
}

/**
 * Finalize lead-dispatch INTENTS stranded 'dispatched' with no lead_run_id. The relay
 * (lead-dispatch-relay.ts) claims a queued intent (pending→dispatched CAS) BEFORE it
 * awaits startAgentRun; if the main process crashes in that window the row is left
 * 'dispatched', lead_run_id NULL. Nothing else recovers it: it is no longer 'pending' (so
 * the drain skips it), and getActiveLeadDispatchByAssignment derives a 'dispatched' row
 * with NO lead_run_id as still ACTIVE — it cannot prove the run was never spawned, so it
 * blocks fail-safe (the Chief's re-dispatch is rejected) — the assignment could never get
 * a lead. (A 'dispatched' row WITH a run is retired by derivation once that run reaches
 * terminal — this sweep exists only for the run-less orphan.) Mark it 'failed' (the
 * assignment link is still NULL → the Chief can re-dispatch a fresh intent).
 * We deliberately do NOT re-'pending' it: a crash AFTER startAgentRun spawned the run but
 * BEFORE setLeadDispatchRun recorded it would then double-execute the lead. Mirrors
 * reconcileStaleRuns (pure DB; takes the handle for unit-testing). Returns rows reconciled.
 */
export function reconcileOrphanedLeadDispatches(d: import('better-sqlite3').Database = db): number {
  const res = d
    .prepare(`UPDATE lead_dispatches SET status = 'failed', dispatched_at = ? WHERE status = 'dispatched' AND lead_run_id IS NULL`)
    .run(Date.now())
  return res.changes
}

/**
 * Clear k_threads stranded pointing at a DEAD warm run. Live-observed after a
 * crash/boot: a thread stuck status='active' with an active_run_id whose run is
 * already terminal (the captureAnswers subscriber that would have cleared it does
 * not survive a restart) or whose runs row is missing entirely. The warm-path
 * check (k-thread.ts::isWarm) would treat such a pointer as cold anyway, but the
 * stale 'active' status misreports the thread forever — so the boot sweep resets it:
 * active_run_id → NULL, status → 'idle', updated_at stamped. Runs AFTER
 * reconcileStaleRuns so runs just flipped 'interrupted' are covered. A thread whose
 * run is still live is untouched. Terminal set built from run-lifecycle.ts::
 * TERMINAL_RUN_STATUSES (bound, not interpolated values). Mirrors the sibling
 * sweeps (pure DB mutation; takes the handle for unit-testing). Returns rows swept.
 */
export function reconcileStaleKThreads(d: import('better-sqlite3').Database = db): number {
  const terminal = [...TERMINAL_RUN_STATUSES]
  const placeholders = terminal.map(() => '?').join(', ')
  const res = d
    .prepare(
      `UPDATE k_threads SET active_run_id = NULL, status = 'idle', updated_at = ?
       WHERE active_run_id IS NOT NULL
         AND (
           NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = k_threads.active_run_id)
           OR EXISTS (
             SELECT 1 FROM runs r
             WHERE r.id = k_threads.active_run_id AND r.status IN (${placeholders})
           )
         )`,
    )
    .run(Date.now(), ...terminal)
  return res.changes
}

/**
 * Best-effort prune of orphaned git worktrees left by crashed runs. Runs
 * `git worktree prune` then removes leftover `.worktrees/*` directories that no
 * longer map to an active run. Never throws — Windows file locks can make removal
 * fail, so every step is guarded and logged. Call after reconcileStaleRuns().
 */
export function pruneOrphanWorktrees(): void {
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, stdio: 'ignore' })
  } catch (err) {
    console.warn('[supervisor] git worktree prune failed:', (err as Error).message)
  }
  try {
    if (!fs.existsSync(WORKTREES_DIR)) return
    for (const entry of fs.readdirSync(WORKTREES_DIR)) {
      // Active runs hold their worktree dir; reconcileStaleRuns nulled the rest,
      // so anything on disk here is orphaned. Remove best-effort.
      if (activeProcesses.has(entry)) continue
      const dir = path.join(WORKTREES_DIR, entry)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[supervisor] could not remove orphan worktree ${dir}:`, (err as Error).message)
      }
    }
  } catch (err) {
    console.warn('[supervisor] worktree dir sweep failed:', (err as Error).message)
  }
}

/**
 * One-shot boot reconciliation: mark crashed runs terminal, then prune orphan
 * worktrees. Wired into core bootstrap (index.ts). Never throws.
 */
export function reconcileOnBoot(): void {
  try {
    const n = reconcileStaleRuns()
    if (n > 0) console.log(`[supervisor] boot sweep: marked ${n} stale run(s) interrupted`)
  } catch (err) {
    console.warn('[supervisor] reconcileStaleRuns failed:', (err as Error).message)
  }
  // After reconcileStaleRuns so runs it just flipped 'interrupted' are covered.
  try {
    const k = reconcileStaleKThreads()
    if (k > 0) console.log(`[supervisor] boot sweep: cleared ${k} stale K thread(s) to idle`)
  } catch (err) {
    console.warn('[supervisor] reconcileStaleKThreads failed:', (err as Error).message)
  }
  try {
    const o = reconcileOrphanedActivations()
    if (o > 0) console.log(`[supervisor] boot sweep: finalized ${o} orphaned activation(s) by run status`)
  } catch (err) {
    console.warn('[supervisor] reconcileOrphanedActivations failed:', (err as Error).message)
  }
  try {
    const m = reconcileStaleActivations()
    if (m > 0) console.log(`[supervisor] boot sweep: marked ${m} stale agent activation(s) failed`)
  } catch (err) {
    console.warn('[supervisor] reconcileStaleActivations failed:', (err as Error).message)
  }
  try {
    const p = reconcileOrphanedLeadDispatches()
    if (p > 0) console.log(`[supervisor] boot sweep: reset ${p} stranded lead-dispatch intent(s) to failed`)
  } catch (err) {
    console.warn('[supervisor] reconcileOrphanedLeadDispatches failed:', (err as Error).message)
  }
  pruneOrphanWorktrees()
  // Sweep per-run config dirs orphaned by a crash — same key space (run id) as
  // worktrees, so anything not held by an active process is stale.
  pruneOrphanAgentRuns(new Set(activeProcesses.keys()))
}

// Interactive runs whose session the operator gracefully ended (stdin closed) —
// so the final exit is reported as 'done', not 'killed'/'error'.
const endingRuns = new Set<string>()

/** True when a stream-json line marks the end of an agent turn (`{type:"result"}`).
 *  In interactive mode this is the boundary where we park the run at awaiting_input
 *  instead of completing it (the process stays alive on stdin). */
function isTurnEndLine(line: string): boolean {
  try { return (JSON.parse(line) as { type?: string }).type === 'result' } catch { return false }
}

async function runAgent(run: Run, prompt: string, cwd: string, inWorktree: boolean, interactive: boolean, profile: AgentProfile = DEFAULT_PROFILE) {
  emitStatusEvent(run.id, 'running', nextSeq(run.id), Date.now())
  eventBus.emitRunUpdate({ ...run, status: 'running' })

  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0

  // Per-run K-owned config dir for managed claude runs (undefined for ollama).
  // Declared before the try so both terminal paths can clean it up.
  let synth: SynthesizedConfig | undefined

  try {
    // Dispatch on the routed provider — never hard-code "claude". buildArgs and
    // parseLine both come from the routed provider, so an ollama run is spawned
    // AND parsed as ollama (a routing/parsing mismatch is structurally impossible).
    const provider = getProvider(run.provider)

    // Claude is K's agent engine: synthesize an isolated CLAUDE_CONFIG_DIR so the
    // host ~/.claude is NEVER loaded and the run gets K's per-tier allowlist, MCP,
    // settings, and injected L0+L1 system prompt. ollama runs are unaffected.
    if (provider.name === 'claude') {
      synth = synthesizeConfigDir(profile, { runId: run.id })
    }

    const proc = execa(
      provider.binary,
      provider.buildArgs(prompt, {
        inWorktree, permissionMode: PERMISSION_MODE, model: run.model, interactive,
        claudeConfig: synth
          ? {
              allowedTools: synth.allowedTools,
              disallowedTools: synth.disallowedTools,
              mcpConfigPath: synth.mcpConfigPath,
              settingsPath: synth.settingsPath,
              appendSystemPromptFile: synth.appendSystemPromptFile,
            }
          : undefined,
      }),
      // Point CLAUDE_CONFIG_DIR at the synthesized dir (+ resolved auth) for claude;
      // K_RUN_ID identifies the run to the kstore MCP child (it also reads it from
      // mcp.json env; the spawn env is the process-wide, defense-in-depth copy, and
      // K_DATA_DIR already propagates via ...process.env). ollama keeps today's
      // env-free spawn options byte-for-byte unchanged.
      synth
        ? { cwd, reject: false, all: true, env: { ...process.env, CLAUDE_CONFIG_DIR: synth.configDir, K_RUN_ID: run.id, ...synth.authEnv } }
        : { cwd, reject: false, all: true }
    )

    activeProcesses.set(run.id, { kill: proc.kill.bind(proc), stdin: proc.stdin, interactive })

    // Interactive runs read EVERY turn from stdin (the prompt is not in argv), so
    // seed the first turn here. EPIPE (process already gone) is handled by the exit path.
    if (interactive && proc.stdin) {
      try { proc.stdin.write(userTurnEnvelope(prompt)) } catch { /* exit path finalizes */ }
    }

    // Stream output line by line
    if (proc.stdout) {
      let buf = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const s = nextSeq(run.id)
          // Parse with the ROUTED provider's parser, then validate at the ingest
          // boundary so malformed output can't poison the store or WS stream.
          const parsed = provider.parseLine(line, run.id, s)
          const event = parsed ? validateAgentEvent(parsed, run.id, s) : null
          if (event) {
            // Accumulate usage (last-wins overwrite; a real 0 is a legitimate value)
            ;({ tokensIn, tokensOut, costUsd } = accumulate({ tokensIn, tokensOut, costUsd }, event))
            eventBus.emitEvent(event)
          }
          // Interactive: a `result` line ends a turn while the process stays alive
          // on stdin. Park the run at awaiting_input (not done) and arm an idle
          // timeout; sendInput() flips it back to running with the next turn.
          if (interactive && !endingRuns.has(run.id) && isTurnEndLine(line)) {
            emitStatusEvent(run.id, 'awaiting_input', nextSeq(run.id), Date.now())
            eventBus.emitRunUpdate({ ...run, status: 'awaiting_input', tokensIn, tokensOut, costUsd })
            clearIdleTimer(run.id)
            idleTimers.set(run.id, setTimeout(() => { endSession(run.id) }, INTERACTIVE_IDLE_MS))
          }
        }
      })
    }

    const result = await proc
    const wasKilled = killedRuns.delete(run.id)
    const wasEnded = endingRuns.delete(run.id)
    // A gracefully-ended interactive session is 'done' regardless of the exit code
    // (a fallback SIGTERM may have stopped a process that ignored stdin EOF).
    const finalStatus: Run['status'] =
      wasKilled ? 'killed' : wasEnded ? 'done' : result.exitCode === 0 ? 'done' : 'error'
    const finalRun: Run = { ...run, status: finalStatus, tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    emitStatusEvent(run.id, finalStatus, nextSeq(run.id), Date.now())
    eventBus.emitRunUpdate(finalRun)
    clearRunTracking(run.id)
    await removeWorktree(run)
    try { synth?.cleanup() } catch { /* best-effort */ }

  } catch (err) {
    const wasKilled = killedRuns.delete(run.id)
    // endingRuns is cleared by clearRunTracking below; no need to delete it here.
    const errRun: Run = { ...run, status: wasKilled ? 'killed' : 'error', tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    const errEvent: AgentEvent = {
      id: uuid(), runId: run.id, seq: nextSeq(run.id), type: 'error',
      ts: Date.now(), text: String(err),
    }
    eventBus.emitEvent(errEvent)
    eventBus.emitRunUpdate(errRun)
    clearRunTracking(run.id)
    await removeWorktree(run)
    try { synth?.cleanup() } catch { /* best-effort */ }
  }
}

/** Map a runs-table row to a Run (the few fields emitRunUpdate + WS run_update need). */
function loadRun(runId: string): Run | null {
  const r = runsDb.getRun.get(runId) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: r.id as string,
    prompt: r.prompt as string,
    cwd: r.cwd as string,
    worktree: (r.worktree as string | null) ?? undefined,
    status: r.status as Run['status'],
    provider: r.provider as Run['provider'],
    model: r.model as string,
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    projectId: (r.project_id as string | null) ?? undefined,
    createdAt: Number(r.created_at),
    endedAt: r.ended_at != null ? Number(r.ended_at) : undefined,
  }
}

/**
 * Feed one operator turn into an interactive run that is parked at awaiting_input.
 * Returns false if the run has no live interactive process or isn't awaiting input
 * (a stale client can't shove input into a mid-turn or finished run). Persists the
 * turn as a `user` event so the console shows it, then flips the run back to running.
 */
export function sendInput(runId: string, text: string): boolean {
  const proc = activeProcesses.get(runId)
  if (!proc || !proc.interactive || !proc.stdin) return false

  // Atomically claim the parked turn: only the caller whose UPDATE actually flips
  // awaiting_input → running may proceed. A second/concurrent caller sees
  // changes===0 (the row is already 'running' or otherwise not awaiting) → false.
  // This replaces the prior read-then-check, which was only safe by virtue of this
  // function being fully synchronous.
  if (claimAwaitingTurn.run(runId).changes === 0) return false

  try {
    proc.stdin.write(userTurnEnvelope(text))
  } catch {
    return false // EPIPE — process died after we claimed the turn; the proc-exit path finalizes the run
  }
  clearIdleTimer(runId)
  // loadRun gives us the Run object emitRunUpdate needs (status is now 'running' in
  // the DB after the claim above; we don't rely on it for the guard).
  const run = loadRun(runId)
  eventBus.emitEvent({ id: uuid(), runId, seq: nextSeq(runId), type: 'user', ts: Date.now(), text })
  emitStatusEvent(runId, 'running', nextSeq(runId), Date.now())
  if (run) eventBus.emitRunUpdate({ ...run, status: 'running' })
  return true
}

/**
 * Gracefully end an interactive session: close stdin (EOF) so the agent finishes
 * and exits with status 'done'. A fallback SIGTERM stops a process that ignores
 * EOF; the run is still finalized as 'done' (endingRuns). No-op (false) for a
 * non-interactive or already-gone run.
 */
export function endSession(runId: string): boolean {
  const proc = activeProcesses.get(runId)
  if (!proc || !proc.interactive || !proc.stdin) return false
  clearIdleTimer(runId)
  endingRuns.add(runId)
  try { proc.stdin.end() } catch { /* already closed — exit path finalizes */ }
  const timer = setTimeout(() => {
    endTimers.delete(runId)
    if (activeProcesses.has(runId)) proc.kill('SIGTERM')
  }, 4000)
  endTimers.set(runId, timer)
  return true
}

type Usage = { tokensIn: number; tokensOut: number; costUsd: number }

/**
 * Roll a parsed event's usage into the running totals with last-wins/overwrite
 * semantics. Guards are explicit `!= null` nullish checks (not truthy) so a
 * legitimate `0` (cache-only turn, free/Ollama run, total_cost_usd: 0) is
 * recorded instead of letting the prior non-zero value persist.
 */
export function accumulate(prev: Usage, event: AgentEvent): Usage {
  return {
    tokensIn: event.tokensIn != null ? event.tokensIn : prev.tokensIn,
    tokensOut: event.tokensOut != null ? event.tokensOut : prev.tokensOut,
    costUsd: event.costUsd != null ? event.costUsd : prev.costUsd,
  }
}

/**
 * Validate a parsed event at the agent-ingest boundary: events that fail
 * AgentEventSchema are dropped and logged rather than persisted+broadcast, so
 * malformed provider output can't poison the store or the WebSocket stream.
 * Applied to every provider's parser output in the stream loop above.
 */
export function validateAgentEvent(event: AgentEvent, runId: string, seq: number): AgentEvent | null {
  const parsed = AgentEventSchema.safeParse(event)
  if (!parsed.success) {
    console.warn(`[supervisor] dropping malformed event (run ${runId}, seq ${seq}):`, parsed.error.message)
    return null
  }
  return parsed.data
}

/**
 * Parse one claude NDJSON line into a validated AgentEvent (or null to ignore).
 *
 * This is the supervisor's **validated-ingest seam**, NOT a redundant re-export:
 * it composes the claude provider's pure `parseClaudeLine` with
 * `validateAgentEvent`, so a line that fails AgentEventSchema is dropped (null)
 * rather than passed through. The supervisor's ingest tests target this wrapper
 * precisely because it pins that parse-then-validate boundary in one call.
 */
export function parseLine(
  line: string,
  runId: string,
  seq: number,
): AgentEvent | null {
  const event = parseClaudeLine(line, runId, seq)
  if (event === null) return null
  return validateAgentEvent(event, runId, seq)
}

function emitStatusEvent(runId: string, status: string, seq: number, ts: number) {
  eventBus.emitEvent({
    id: uuid(), runId, seq, type: 'status', ts, text: status,
  })
}

/**
 * Test-only seam for the interactive-HITL failure-mode tests. There is no
 * production way to register a fake child against `activeProcesses` (it's filled
 * only by runAgent spawning a real CLI), so these helpers let a test seed/clear
 * a minimal fake ActiveProc and arm the idle timer without launching `claude`.
 * NOT part of the public API — keep usage confined to core/test/*.
 */
export const __testHooks = {
  /** Register a fake interactive process for `runId`. */
  setActiveProc(runId: string, proc: ActiveProc) { activeProcesses.set(runId, proc) },
  /** Remove a run's fake process + any of its timers/seq state. */
  clearActiveProc(runId: string) { clearRunTracking(runId) },
  /** True if an idle timer is currently armed for `runId`. */
  hasIdleTimer(runId: string): boolean { return idleTimers.has(runId) },
  /** Arm the awaiting-input idle timer for `runId` exactly as runAgent does. */
  armIdleTimer(runId: string) {
    clearIdleTimer(runId)
    idleTimers.set(runId, setTimeout(() => { endSession(runId) }, INTERACTIVE_IDLE_MS))
  },
  /** Initialise the per-run seq counter so emit paths have a base. */
  initSeq(runId: string) { seqCounters.set(runId, 0) },
}
