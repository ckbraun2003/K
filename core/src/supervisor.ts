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
import { AgentEventSchema, type AgentEvent, type Run } from '@k/shared'
import { eventBus } from './events.js'
import { db, runsDb, projectsDb } from './db.js'
import { route } from './router.js'
import { resolvePermissionMode } from './claude-args.js'
import { getProvider, parseClaudeLine, type ParseCtx } from './providers.js'
import { matchProjectByCwd, type ProjectPathRow } from './project-match.js'

const PERMISSION_MODE = resolvePermissionMode(process.env.RUN_PERMISSION_MODE)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// core/src/* and core/dist/* are both two levels below the repo root
export const REPO_ROOT = path.join(__dirname, '../../')
const WORKTREES_DIR = path.join(__dirname, '../../.worktrees')

fs.mkdirSync(WORKTREES_DIR, { recursive: true })

// Active processes keyed by runId — minimal interface to avoid execa generic variance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeProcesses = new Map<string, { kill: (...args: any[]) => any }>()

// Runs terminated by the operator — exit codes alone can't distinguish a kill
// (non-zero exit) from a genuine agent failure
const killedRuns = new Set<string>()

// Pending SIGKILL-escalation timers keyed by runId, so a killed-then-exited run
// clears its timer instead of leaving a dangling 3s handle. Cleared in the
// run-completion path alongside activeProcesses.delete().
const killTimers = new Map<string, ReturnType<typeof setTimeout>>()

export type StartRunOptions = {
  cwd?: string
  model?: string
  preferLocal?: boolean
  maxCostUsd?: number
  projectId?: string
}

export async function startRun(prompt: string, opts: StartRunOptions = {}): Promise<Run> {
  const routeResult = route({ prompt, preferLocal: opts.preferLocal, maxCostUsd: opts.maxCostUsd })
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

  // Emit initial status event
  emitStatusEvent(runId, 'queued', 0, now)
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

  // Launch in background — don't await
  void runAgent(run, prompt, effectiveCwd, inWorktree)

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

/** Forget a run's process + clear any pending SIGKILL-escalation timer. */
function clearRunTracking(runId: string) {
  activeProcesses.delete(runId)
  const timer = killTimers.get(runId)
  if (timer) {
    clearTimeout(timer)
    killTimers.delete(runId)
  }
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
 * Flip every `running`/`queued` run to the terminal `interrupted` status and null
 * its worktree column. At boot these statuses are necessarily stale — no in-flight
 * run survives a process restart — so leaving them inflates the activeRuns metric
 * forever. Pure DB mutation (no FS/git); takes the DB handle so it's unit-testable
 * against a temp DB. Returns the number of rows reconciled.
 */
export function reconcileStaleRuns(d: import('better-sqlite3').Database = db): number {
  const res = d
    .prepare(
      `UPDATE runs SET status = 'interrupted', worktree = NULL, ended_at = ?
       WHERE status IN ('running', 'queued')`,
    )
    .run(Date.now())
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
  pruneOrphanWorktrees()
}

async function runAgent(run: Run, prompt: string, cwd: string, inWorktree: boolean) {
  run.status = 'running'
  emitStatusEvent(run.id, 'running', 1, Date.now())
  eventBus.emitRunUpdate({ ...run })

  let seq = 2
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0

  try {
    // Dispatch on the routed provider — never hard-code "claude". buildArgs and
    // parseLine both come from the routed provider, so an ollama run is spawned
    // AND parsed as ollama (a routing/parsing mismatch is structurally impossible).
    const provider = getProvider(run.provider)
    const proc = execa(
      provider.binary,
      provider.buildArgs(prompt, { inWorktree, permissionMode: PERMISSION_MODE, model: run.model }),
      { cwd, reject: false, all: true }
    )

    activeProcesses.set(run.id, proc)

    // Stream output line by line
    if (proc.stdout) {
      let buf = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const s = seq++
          // Parse with the ROUTED provider's parser, then validate at the ingest
          // boundary so malformed output can't poison the store or WS stream.
          const parsed = provider.parseLine(line, run.id, s, { tokensIn, tokensOut, costUsd })
          const event = parsed ? validateAgentEvent(parsed, run.id, s) : null
          if (event) {
            // Accumulate usage (last-wins overwrite; a real 0 is a legitimate value)
            ;({ tokensIn, tokensOut, costUsd } = accumulate({ tokensIn, tokensOut, costUsd }, event))
            eventBus.emitEvent(event)
          }
        }
      })
    }

    const result = await proc
    clearRunTracking(run.id)
    await removeWorktree(run)

    const wasKilled = killedRuns.delete(run.id)
    const finalStatus: Run['status'] = wasKilled ? 'killed' : result.exitCode === 0 ? 'done' : 'error'
    const finalRun: Run = { ...run, status: finalStatus, tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    emitStatusEvent(run.id, finalStatus, seq, Date.now())
    eventBus.emitRunUpdate(finalRun)

  } catch (err) {
    clearRunTracking(run.id)
    await removeWorktree(run)
    const wasKilled = killedRuns.delete(run.id)
    const errRun: Run = { ...run, status: wasKilled ? 'killed' : 'error', tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    const errEvent: AgentEvent = {
      id: uuid(), runId: run.id, seq: seq++, type: 'error',
      ts: Date.now(), text: String(err),
    }
    eventBus.emitEvent(errEvent)
    eventBus.emitRunUpdate(errRun)
  }
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
 * Thin wrapper over the claude provider's parser + `validateAgentEvent`,
 * re-exported here (vs. providers.ts) so existing supervisor tests importing
 * `parseLine` keep working.
 */
export function parseLine(
  line: string,
  runId: string,
  seq: number,
  ctx: ParseCtx
): AgentEvent | null {
  const event = parseClaudeLine(line, runId, seq, ctx)
  if (event === null) return null
  return validateAgentEvent(event, runId, seq)
}

function emitStatusEvent(runId: string, status: string, seq: number, ts: number) {
  eventBus.emitEvent({
    id: uuid(), runId, seq, type: 'status', ts, text: status,
  })
}
