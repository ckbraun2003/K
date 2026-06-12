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
import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import type { AgentEvent, Run } from '@k/shared'
import { eventBus } from './events.js'
import { runsDb, projectsDb } from './db.js'
import { route } from './router.js'
import { resolvePermissionMode, buildClaudeArgs } from './claude-args.js'
import { matchProjectByCwd, type ProjectPathRow } from './project-match.js'

const PERMISSION_MODE = resolvePermissionMode(process.env.RUN_PERMISSION_MODE)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// core/src/* and core/dist/* are both two levels below the repo root
const REPO_ROOT = path.join(__dirname, '../../')
const WORKTREES_DIR = path.join(__dirname, '../../.worktrees')

fs.mkdirSync(WORKTREES_DIR, { recursive: true })

// Active processes keyed by runId — minimal interface to avoid execa generic variance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeProcesses = new Map<string, { kill: (...args: any[]) => any }>()

// Runs terminated by the operator — exit codes alone can't distinguish a kill
// (non-zero exit) from a genuine agent failure
const killedRuns = new Set<string>()

export type StartRunOptions = {
  cwd?: string
  model?: string
  preferLocal?: boolean
  projectId?: string
}

export async function startRun(prompt: string, opts: StartRunOptions = {}): Promise<Run> {
  const routeResult = route({ prompt, preferLocal: opts.preferLocal })
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
  setTimeout(() => {
    if (activeProcesses.has(runId)) proc.kill('SIGKILL')
  }, 3000)
  return true
}

// ── Private ──────────────────────────────────────────────────────────────────

async function removeWorktree(run: Run) {
  if (run.worktree && fs.existsSync(run.worktree)) {
    try {
      await execa('git', ['-C', run.cwd, 'worktree', 'remove', '--force', run.worktree])
    } catch { /* best-effort cleanup */ }
  }
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
    const proc = execa(
      'claude',
      buildClaudeArgs(prompt, { inWorktree, permissionMode: PERMISSION_MODE }),
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
          const event = parseLine(line, run.id, seq++, { tokensIn, tokensOut, costUsd })
          if (event) {
            // Accumulate usage
            if (event.tokensIn) tokensIn = event.tokensIn
            if (event.tokensOut) tokensOut = event.tokensOut
            if (event.costUsd) costUsd = event.costUsd
            eventBus.emitEvent(event)
          }
        }
      })
    }

    const result = await proc
    activeProcesses.delete(run.id)
    await removeWorktree(run)

    const wasKilled = killedRuns.delete(run.id)
    const finalStatus: Run['status'] = wasKilled ? 'killed' : result.exitCode === 0 ? 'done' : 'error'
    const finalRun: Run = { ...run, status: finalStatus, tokensIn, tokensOut, costUsd, endedAt: Date.now() }
    emitStatusEvent(run.id, finalStatus, seq, Date.now())
    eventBus.emitRunUpdate(finalRun)

  } catch (err) {
    activeProcesses.delete(run.id)
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

function parseLine(
  line: string,
  runId: string,
  seq: number,
  _ctx: { tokensIn: number; tokensOut: number; costUsd: number }
): AgentEvent | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    const type = (obj.type as string) ?? 'assistant'

    const event: AgentEvent = {
      id: uuid(),
      runId,
      seq,
      type: mapType(type),
      ts: Date.now(),
      raw: line,
    }

    // Extract display text
    if (type === 'assistant' && obj.message) {
      const msg = obj.message as Record<string, unknown>
      const content = msg.content as Array<Record<string, unknown>> | undefined
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') event.text = String(block.text ?? '')
          if (block.type === 'tool_use') event.tool = String(block.name ?? '')
        }
      }
      // Usage from message
      const usage = msg.usage as Record<string, number> | undefined
      if (usage) {
        if (usage.input_tokens) event.tokensIn = usage.input_tokens
        if (usage.output_tokens) event.tokensOut = usage.output_tokens
      }
    }

    if (type === 'result') {
      const stats = obj as Record<string, unknown>
      // Current CLI nests usage and reports total_cost_usd; keep the old
      // top-level fields as fallbacks for older CLI versions
      const usage = stats.usage as Record<string, number> | undefined
      const tokensIn = usage
        ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        : typeof stats.input_tokens === 'number' ? stats.input_tokens : 0
      const tokensOut = usage?.output_tokens ?? (typeof stats.output_tokens === 'number' ? stats.output_tokens : 0)
      if (tokensIn) event.tokensIn = tokensIn
      if (tokensOut) event.tokensOut = tokensOut
      const cost = typeof stats.total_cost_usd === 'number' ? stats.total_cost_usd
        : typeof stats.cost_usd === 'number' ? stats.cost_usd : 0
      if (cost) event.costUsd = cost
      event.text = typeof stats.result === 'string' ? stats.result : undefined
    }

    return event
  } catch {
    // Tolerant: ignore malformed lines
    return null
  }
}

function mapType(raw: string): AgentEvent['type'] {
  if (raw === 'system') return 'system'
  if (raw === 'assistant') return 'assistant'
  if (raw === 'user') return 'user'
  if (raw === 'result') return 'usage'
  return 'assistant'
}

function emitStatusEvent(runId: string, status: string, seq: number, ts: number) {
  eventBus.emitEvent({
    id: uuid(), runId, seq, type: 'status', ts, text: status,
  })
}
