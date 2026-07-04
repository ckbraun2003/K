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
import { isPathWithin } from './paths.js'
import { synthesizeConfigDir, pruneOrphanAgentRuns, kSecretaryConfigPaths, type SynthesizedConfig } from './agent-config.js'
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
  /** W7a (K-secretary ONLY): make this a RESUMABLE one-shot run against a STABLE,
   *  persisted per-thread config dir + cwd instead of a fresh worktree + ephemeral
   *  per-run config. `key` is the K thread id (keys the stable dir/cwd); `sessionId` is
   *  the CLI session id; `resume` false → establish it (`--session-id`), true → continue
   *  it (`--resume`). Absent for every regular dispatch run → fresh worktree, fresh
   *  synthesized config, no session flags — byte-for-byte the prior behavior. */
  persistentSession?: { key: string; sessionId: string; resume: boolean }
  /** H8 (OPT-IN): after adding the run's detached worktree, replay the SOURCE repo's
   *  UNCOMMITTED tracked+staged changes into it so the agent starts from the operator's
   *  dirty state (see applyWorkingTreeInto for the exact semantics — untracked/ignored
   *  files are NOT carried). Default false/undefined → the worktree stays at clean
   *  committed HEAD, BYTE-IDENTICAL to the prior behavior. Ignored for a persistent
   *  session (no worktree) and for a non-git cwd (falls back to running in cwd). */
  carryWorkingTree?: boolean
}

/**
 * F-068: whether a run must SUPPRESS the gitnexus bootstrap (MCP server + analyze hook).
 * True ONLY for a dispatch operating on an EXTERNAL repo — its ORIGINAL cwd (`run.cwd`, the
 * project's localPath, NEVER the ephemeral worktree) resolves OUTSIDE the K repo. A
 * K-secretary PERSISTENT SESSION is never external: its stable cwd lives under K_DATA_DIR,
 * which is env-overridable and may be relocated OUTSIDE the repo — such a run is still
 * K-internal and must keep gitnexus regardless of where the data dir lives (MEDIUM-1). Pure +
 * exported so the exact predicate runAgent uses is unit-lockable (guards a future refactor
 * that might pass the worktree path instead of run.cwd — MEDIUM-2).
 */
export function shouldSuppressGitnexus(runCwd: string, isPersistentSession: boolean): boolean {
  if (isPersistentSession) return false
  return !isPathWithin(REPO_ROOT, runCwd, { inclusive: true })
}

export async function startRun(prompt: string, opts: StartRunOptions = {}): Promise<Run> {
  // An explicitly-named model is always a Claude model id (validated at the route
  // boundary), so it overrides any local-model preference — never route an
  // explicit `claude-*` id to `ollama run <id>`.
  // An explicit model forces claude; the cost branch in route() is meaningless
  // (and could mis-select ollama for a claude-* id), so neutralize maxCostUsd too.
  const routeResult = route({ prompt, preferLocal: opts.model ? false : opts.preferLocal, maxCostUsd: opts.model ? undefined : opts.maxCostUsd })
  const runId = uuid()
  // W7a: a K-secretary ask runs in a STABLE per-thread cwd (so the CLI's session files,
  // keyed by cwd, persist for `--resume`) — never a fresh worktree. Absent for regular
  // runs → the caller's cwd (or the repo root), unchanged.
  const ps = opts.persistentSession
  const kPaths = ps ? kSecretaryConfigPaths(ps.key) : undefined
  const cwd = kPaths?.cwd ?? opts.cwd ?? REPO_ROOT
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
  if (ps) {
    // K-secretary ask: run directly in the STABLE per-thread cwd — K does logistics/Q&A/
    // routing, not code, so it needs NO throwaway worktree, and a stable cwd is what lets
    // `--resume` find the session. Ensure the dir exists; never a worktree.
    fs.mkdirSync(cwd, { recursive: true })
    run.worktree = undefined
    runsDb.clearRunWorktree.run(run.id)
    effectiveCwd = cwd
  } else {
    try {
      // Only create worktree if cwd is inside a git repo
      await execa('git', ['-C', cwd, 'rev-parse', '--git-dir'], { reject: true })
      await execa('git', ['-C', cwd, 'worktree', 'add', '--detach', worktreePath], { reject: true })
      effectiveCwd = worktreePath
      // H8 (opt-in): replay the source's uncommitted tracked+staged WIP into the fresh
      // worktree so the run sees the dirty state. Guarded by the flag, so when it is
      // absent this branch is never entered and the worktree stays at clean committed
      // HEAD — byte-identical to before. applyWorkingTreeInto never throws (a carry
      // failure degrades to a clean-HEAD run), so it can't disturb the worktree fallback.
      if (opts.carryWorkingTree) await applyWorkingTreeInto(cwd, worktreePath)
    } catch {
      // Not a git repo or worktree failed — run in cwd directly
      effectiveCwd = cwd
      run.worktree = undefined
      runsDb.clearRunWorktree.run(run.id)
    }
  }

  const inWorktree = effectiveCwd === worktreePath

  // Launch in background — don't await. The profile (default: orchestrator) drives
  // per-tier config synthesis inside runAgent. A persistent session (K only) threads the
  // stable run dir + session id/resume through.
  const session = ps ? { runDir: kPaths!.runDir, sessionId: ps.sessionId, resume: ps.resume } : undefined
  void runAgent(run, prompt, effectiveCwd, inWorktree, interactive, opts.profile ?? DEFAULT_PROFILE, session)

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

/**
 * H8 (opt-in carryWorkingTree): copy the SOURCE repo's UNCOMMITTED tracked+staged
 * changes INTO a freshly-added detached worktree so a dispatched run can start from
 * the operator's dirty state instead of clean committed HEAD.
 *
 * Mechanism: `git -C <src> stash create` snapshots the tracked+staged WIP as a
 * stash-format commit-ish WITHOUT touching the source working tree or the stash list
 * (it is a pure, non-destructive capture — the operator's tree is left exactly as it
 * was). A clean tree prints nothing → no-op (returns false). Otherwise we
 * `git -C <wt> stash apply <sha>` to replay that WIP into the worktree; because the
 * worktree is detached at the same HEAD the stash was based on, it applies cleanly and
 * restores both modified tracked files and staged (index) changes, including deletions.
 *
 * SEMANTICS — what is / isn't carried:
 *   • CARRIED: modified tracked files + staged (index) changes.
 *   • NOT carried: UNTRACKED files and ignored files. `git stash create` omits them by
 *     design, and the only way to include them (`git stash push -u`) MUTATES the source
 *     working tree — unacceptable for a read-only capture — so untracked work is
 *     deliberately left behind. A run that needs an untracked file should `git add` it
 *     first (staged files ARE carried).
 * The run commits to its own branch as usual; the --force worktree removal only discards
 * still-uncommitted residue, exactly like any run — so there is no write-back to do.
 *
 * Best-effort + NEVER throws: a carry failure must not abort the dispatch — the run
 * simply starts from clean committed HEAD (today's behavior). Returns true iff WIP was
 * applied, false if the source was clean or the carry was skipped/failed.
 */
export async function applyWorkingTreeInto(sourceCwd: string, worktreePath: string): Promise<boolean> {
  try {
    // `stash create` writes the commit-ish to stdout (empty string when the tree is
    // clean). It does NOT alter the working tree or push onto the stash list.
    const { stdout } = await execa('git', ['-C', sourceCwd, 'stash', 'create'], { reject: true })
    const sha = stdout.trim()
    if (!sha) return false // clean source tree → nothing to carry
    await execa('git', ['-C', worktreePath, 'stash', 'apply', sha], { reject: true })
    return true
  } catch (err) {
    console.warn('[supervisor] carryWorkingTree failed — run starts from clean HEAD:', (err as Error).message)
    return false
  }
}

// ── Private ──────────────────────────────────────────────────────────────────

/**
 * H7: run a worktree-removal `attempt` with a small retry-with-backoff. On Windows a
 * lingering child handle can make `git worktree remove --force` fail EBUSY transiently;
 * retrying a few times with a short linear backoff lets the handle release so a
 * transient failure doesn't leak the worktree to the next-boot prune. The FINAL
 * attempt's failure is not rethrown — cleanup must NEVER throw. Exported + parameterized
 * (attempt fn, attempts, delay, injectable sleep) so the retry logic is unit-testable
 * without a real worktree or real timers. Returns true on eventual success, false if
 * every attempt failed. The happy path (first attempt succeeds) adds ZERO delay.
 */
export async function removeWorktreeWithRetry(
  attempt: () => Promise<void>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3
  const delayMs = opts.delayMs ?? 150
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    try {
      await attempt()
      return true
    } catch {
      // Back off before the next try; no sleep after the last (failed) attempt.
      if (i < attempts - 1) await sleep(delayMs * (i + 1))
    }
  }
  return false
}

async function removeWorktree(run: Run) {
  if (run.worktree && fs.existsSync(run.worktree)) {
    // Retry a transient Windows EBUSY (lingering child handle) before the final
    // best-effort swallow; removeWorktreeWithRetry never throws.
    await removeWorktreeWithRetry(() =>
      execa('git', ['-C', run.cwd, 'worktree', 'remove', '--force', run.worktree!]).then(() => undefined),
    )
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
 * Clear k_threads stranded pointing at a DEAD run. Live-observed after a
 * crash/boot: a thread stuck status='active' with an active_run_id whose run is
 * already terminal (the captureAnswers subscriber that would have cleared it does
 * not survive a restart) or whose runs row is missing entirely. askK ignores such a
 * pointer anyway (a K ask never continues a dead run), but the stale 'active' status
 * misreports the thread forever — so the boot sweep resets it:
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
  sweepOrphanWorktrees(REPO_ROOT, WORKTREES_DIR, new Set(activeProcesses.keys()))
}

/**
 * Testable core of the orphan-worktree boot sweep (F-091). Removes leftover
 * `<worktreesDir>/*` directories NOT held by an active run, THEN runs
 * `git worktree prune`.
 *
 * F-091 fix: prune runs AFTER the removal loop (previously it ran BEFORE). Pruning
 * first meant a dir removed THIS boot still had its git metadata registered
 * ("prunable") until the NEXT boot; pruning after the removals reclaims that metadata
 * the SAME boot. Never throws — Windows file locks can make removal fail, so every step
 * is guarded and logged. Parameterized (repoRoot, worktreesDir, activeIds) so it is
 * unit-testable against a real temp git repo.
 */
export function sweepOrphanWorktrees(repoRoot: string, worktreesDir: string, activeIds: Set<string>): void {
  try {
    if (fs.existsSync(worktreesDir)) {
      for (const entry of fs.readdirSync(worktreesDir)) {
        // Active runs hold their worktree dir; reconcileStaleRuns nulled the rest,
        // so anything on disk here is orphaned. Remove best-effort.
        if (activeIds.has(entry)) continue
        const dir = path.join(worktreesDir, entry)
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch (err) {
          console.warn(`[supervisor] could not remove orphan worktree ${dir}:`, (err as Error).message)
        }
      }
    }
  } catch (err) {
    console.warn('[supervisor] worktree dir sweep failed:', (err as Error).message)
  }
  // Prune AFTER the removal loop so git metadata for a dir removed THIS boot is
  // reclaimed now, not left registered as 'prunable' until the next boot (F-091).
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' })
  } catch (err) {
    console.warn('[supervisor] git worktree prune failed:', (err as Error).message)
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

async function runAgent(
  run: Run,
  prompt: string,
  cwd: string,
  inWorktree: boolean,
  interactive: boolean,
  profile: AgentProfile = DEFAULT_PROFILE,
  // W7a (K-secretary ONLY): build the config under a STABLE, persisted run dir and pass
  // the CLI session flags. Undefined for every regular run → ephemeral per-run config +
  // no session flags, exactly as before.
  session?: { runDir: string; sessionId: string; resume: boolean },
) {
  emitStatusEvent(run.id, 'running', nextSeq(run.id), Date.now())
  eventBus.emitRunUpdate({ ...run, status: 'running' })

  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  // F-… killed-run honesty: the AUTHORITATIVE usage carrier is the turn-end `result`
  // (type 'usage') line, which a run KILLED mid-turn never emits — leaving tokens at 0
  // (a misleading "0 tokens / $0" for real work). The claude stream DOES carry per-message
  // usage on each `assistant` line, so we accumulate interim usage here (output SUMMED across
  // messages, input MAX — see accumulateInterimUsage) and, on a killed terminal that never
  // summed a `result`, fall back to it (reconcileKilledUsage) so the killed run records its
  // real OBSERVED tokens. Cost is NOT recoverable — the stream reports cost only on `result`.
  let lastInterimUsage: { tokensIn: number; tokensOut: number } | null = null

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
      // A K-secretary ask (session set) builds its config under the STABLE per-thread
      // dir and keeps it (persist) so the CLI session state survives for `--resume`;
      // every regular run gets the ephemeral per-run dir cleaned on terminal, as before.
      //
      // F-068: detect an EXTERNAL-target run — one whose ORIGINAL cwd (run.cwd, the
      // project's localPath, never the ephemeral worktree) is NOT inside the K repo. Such
      // a run works on a linked worktree whose shared git dir is the external project's, so
      // the gitnexus MCP init + analyze hook would write .gitnexus/.gitignore/.claude into
      // the target checkout. Suppress the gitnexus bootstrap for it. K's own runs keep
      // gitnexus — including a K-secretary persistent session, which is NEVER external even
      // when K_DATA_DIR (its stable cwd's root) is relocated outside the repo (MEDIUM-1).
      const suppressGitnexus = shouldSuppressGitnexus(run.cwd, !!session)
      synth = synthesizeConfigDir(
        profile,
        session
          ? { runId: run.id, runDirOverride: session.runDir, persist: true, suppressGitnexus }
          : { runId: run.id, suppressGitnexus },
      )
    }

    const proc = execa(
      provider.binary,
      provider.buildArgs(prompt, {
        inWorktree, permissionMode: PERMISSION_MODE, model: run.model, interactive,
        // Session flags (K only): establish (--session-id) or continue (--resume) the
        // thread's stable CLI session. Absent for regular runs → no session flags.
        sessionId: session?.sessionId,
        resumeSession: session?.resume,
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
            // Accumulate usage (F-057: sum per-turn `usage` events; cost last-wins with
            // a real 0 a legitimate value — see accumulate)
            ;({ tokensIn, tokensOut, costUsd } = accumulate({ tokensIn, tokensOut, costUsd }, event))
            // Best-effort interim-usage capture for the killed-run fallback: an `assistant`
            // line carries THAT MESSAGE'S own usage before the turn-end `result`. Output is
            // SUMMED across messages; input takes the MAX (see accumulateInterimUsage). Only
            // assistant events feed this — never the `result` (type 'usage') event, whose
            // totals accumulate above — so a completed run's accounting is untouched; only a
            // mid-turn kill reads it back.
            lastInterimUsage = accumulateInterimUsage(lastInterimUsage, event)
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
    // Killed-run honesty: a mid-turn kill may have summed no `result` usage — recover the
    // last observed interim tokens so the run isn't recorded as a misleading 0 (no-op for a
    // run that saw a `result`, and for a non-killed terminal).
    ;({ tokensIn, tokensOut, costUsd } = reconcileKilledUsage({ tokensIn, tokensOut, costUsd }, wasKilled, lastInterimUsage))
    const finalRun: Run = { ...run, status: finalStatus, tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    emitStatusEvent(run.id, finalStatus, nextSeq(run.id), Date.now())
    eventBus.emitRunUpdate(finalRun)
    clearRunTracking(run.id)
    await removeWorktree(run)
    try { synth?.cleanup() } catch { /* best-effort */ }

  } catch (err) {
    const wasKilled = killedRuns.delete(run.id)
    // endingRuns is cleared by clearRunTracking below; no need to delete it here.
    // Same killed-run honesty as the success path: recover interim tokens for a mid-turn kill.
    ;({ tokensIn, tokensOut, costUsd } = reconcileKilledUsage({ tokensIn, tokensOut, costUsd }, wasKilled, lastInterimUsage))
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
 * Gracefully end a run.
 *
 * Interactive session (the original path, UNCHANGED): close stdin (EOF) so the agent
 * finishes its turn and exits with status 'done'. A fallback SIGTERM stops a process that
 * ignores EOF; the run is still finalized as 'done' (endingRuns).
 *
 * Non-interactive supervised run — e.g. a relay-dispatched LEAD run supervised in the MAIN
 * process (fix-c): there is NO stdin turn protocol to close, so a graceful "let it finish"
 * is not available — the only early stop is a signal. Previously endSession no-op'd
 * (returned false) for any non-interactive run, so `/end` on a relay lead run left its
 * status STUCK while `/kill` (which reaches the same activeProcesses proc) flipped it. We
 * now route such a run through `kill()` — the same path `/kill` uses to reach relay
 * supervision — so `/end` actually transitions it to a terminal status via runAgent's exit
 * handler. The run did NOT complete its work, so 'killed' (an operator-terminated run,
 * excluded from success metrics) is the honest terminal status, not a misleading 'done'.
 *
 * No-op (false) only for an already-gone run (no live process).
 */
export function endSession(runId: string): boolean {
  const proc = activeProcesses.get(runId)
  if (!proc) return false
  // Non-interactive supervised run (e.g. a relay-dispatched lead run): reach it the same way
  // /kill does so /end flips its status instead of no-op'ing. kill() SIGTERMs now (with a
  // SIGKILL backstop) and marks the run so runAgent's exit path finalizes it 'killed'. Scoped
  // to genuinely NON-interactive procs — the interactive branch below stays byte-identical.
  if (!proc.interactive) return kill(runId)
  // Interactive session but the stdin is already gone: no graceful EOF to send — no-op (false),
  // exactly as before (this case is deliberately NOT routed to kill()).
  if (!proc.stdin) return false
  // Interactive session with live stdin: graceful EOF → agent finishes → 'done' (unchanged).
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
 * Roll a parsed event's usage into the running totals (F-057).
 *
 * The per-turn `usage` event (the claude `result` line — see providers.ts mapType)
 * is the ONE authoritative usage carrier: it reports THAT TURN's full input
 * (input + cache_creation + cache_read) and output. We SUM those across turn
 * boundaries so a multi-turn/interactive run — and a `/compact` turn that reports
 * near-zero fresh input — reflects the TRUE total instead of collapsing to the LAST
 * turn (the prior last-wins bug: the final near-zero result overwrote the real total).
 * A one-shot run has exactly ONE `usage` event, so the sum equals that single
 * whole-run value — byte-identical to before for every regular (one-shot) dispatch.
 *
 * `costUsd` comes from `total_cost_usd`, already a CUMULATIVE running total, so it
 * stays last-wins — with the explicit `!= null` guard preserving the falsy-zero fix
 * (a real 0, e.g. a free/Ollama run, overwrites a stale non-zero instead of persisting
 * it). Non-usage events (streaming assistant text/tool_use, status, …) do NOT move the
 * run totals: the `usage` event is the single source of truth, and folding the
 * streaming assistant token projections in too would double-count.
 */
export function accumulate(prev: Usage, event: AgentEvent): Usage {
  if (event.type !== 'usage') return prev
  return {
    tokensIn: event.tokensIn != null ? prev.tokensIn + event.tokensIn : prev.tokensIn,
    tokensOut: event.tokensOut != null ? prev.tokensOut + event.tokensOut : prev.tokensOut,
    costUsd: event.costUsd != null ? event.costUsd : prev.costUsd,
  }
}

/**
 * Fold one parsed event's INTERIM per-message usage into the best-effort accumulator used for
 * killed-run recovery (reconcileKilledUsage). Only `assistant` events contribute — the
 * authoritative `result`/usage total is summed separately by `accumulate`, so this never
 * touches a completed run's accounting.
 *
 * Reduction semantics (chosen so recovery can only UNDER-count, never over-bill):
 *   - OUTPUT tokens are SUMMED across messages. Each `assistant` line's `tokensOut` is THAT
 *     message's own output (per-message, not cumulative), so a multi-round tool-use turn's real
 *     output is the sum — summing strictly recovers more than last-write-wins.
 *   - INPUT tokens take the MAX observed. An `assistant` line's `tokensIn` is the (growing)
 *     fresh input for that call under prompt caching; summing could double-count shared context,
 *     so MAX is the conservative choice that can only under-count, never over-bill.
 * Returns the updated accumulator (or `prev` unchanged for a non-interim / usage-less event).
 * Pure + exported for direct unit-testing.
 */
export function accumulateInterimUsage(
  prev: { tokensIn: number; tokensOut: number } | null,
  event: AgentEvent,
): { tokensIn: number; tokensOut: number } | null {
  if (event.type !== 'assistant' || (event.tokensIn == null && event.tokensOut == null)) return prev
  const base = prev ?? { tokensIn: 0, tokensOut: 0 }
  return {
    tokensIn: Math.max(base.tokensIn, event.tokensIn ?? 0), // MAX — conservative (never over-bill)
    tokensOut: base.tokensOut + (event.tokensOut ?? 0),     // SUM — per-message output totals
  }
}

/**
 * Killed-run usage honesty (fix-b, Route 1). A run KILLED mid-turn may never emit the
 * authoritative turn-end `result` (type 'usage') line, so `accumulate` leaves its totals
 * at 0 — a misleading "0 tokens / $0" for real work done. The claude stream DOES expose
 * per-message usage on each `assistant` line; `lastInterim` is the best-effort accumulation of
 * that (via accumulateInterimUsage: OUTPUT summed across messages, INPUT the conservative MAX),
 * and this recovers it so a killed run records its real OBSERVED tokens. Best-effort, not
 * precise: input is a floor (MAX single call, not the true multi-call total) — deliberately so
 * recovery can only under-count, never over-bill.
 *
 * Applied ONLY when the run `wasKilled` AND no authoritative usage was ever summed
 * (tokensIn === 0 && tokensOut === 0) — so:
 *   - a run that completed a turn (saw a `result`) keeps its summed totals UNCHANGED (never
 *     double-counted, since interim usage is only a fallback for the never-measured case);
 *   - a non-killed terminal is untouched;
 *   - a kill with no interim usage observed at all (killed before any `assistant` line) stays
 *     at 0 — genuinely UNMEASURED, never fabricated.
 * Cost is passed through unchanged: the stream reports cost ONLY on `result`, so a mid-turn
 * kill has no interim cost signal to recover (a killed run's $0 cost is honestly unmeasured).
 * Pure + exported for direct unit-testing.
 */
export function reconcileKilledUsage(
  totals: Usage,
  wasKilled: boolean,
  lastInterim: { tokensIn: number; tokensOut: number } | null,
): Usage {
  if (!wasKilled || !lastInterim) return totals
  if (totals.tokensIn !== 0 || totals.tokensOut !== 0) return totals
  return { tokensIn: lastInterim.tokensIn, tokensOut: lastInterim.tokensOut, costUsd: totals.costUsd }
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
