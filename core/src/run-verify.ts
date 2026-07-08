/**
 * E-04 verify engine (P1 Lane B) — async post-run recipe battery + change scope.
 *
 * TRIGGER: a terminal 'done' run with a projectId whose project carries a
 * verifyRecipe (no recipe → NO verify row; the chip stays absent). WHERE IT
 * RUNS: a FRESH temp worktree materialized from the run's FINAL checkpoint —
 * the run worktree is already removed at terminal, the checkpoint refs survive
 * in the shared .git, and using a fresh tree means verification never races run
 * cleanup and can be re-run anytime. SCOPE: changed files (checkpoint base →
 * final) + indexed-symbol count from the offline gitnexus-scope leg.
 */
import { execa } from 'execa'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Project, Run, VerifyCommandResult, VerifyResult, VerifyScope } from '@k/shared'
import { verifyResultsDb } from './db.js'
import { eventBus } from './events.js'
import { listRunCheckpoints } from './checkpoints.js'
import { isProjectIndexed, loadGraphJson, scopeForFiles } from './gitnexus-scope.js'

const DEFAULT_CMD_TIMEOUT_MS = 5 * 60_000
const OUTPUT_TAIL_CHARS = 2000
const GIT_BOUND = { timeout: 60_000, killSignal: 'SIGKILL' as const }

// Runs currently being verified — dedups duplicate terminal emits.
const inFlight = new Set<string>()

/** verify_results row → wire shape (defensive JSON columns). */
export function rowToVerifyResult(r: Record<string, unknown>): VerifyResult {
  const parse = <T>(v: unknown, fallback: T): T => {
    if (v == null) return fallback
    try { return JSON.parse(String(v)) as T } catch { return fallback }
  }
  return {
    runId: String(r.run_id),
    status: r.status as VerifyResult['status'],
    reason: r.reason == null ? null : String(r.reason),
    commands: parse<VerifyCommandResult[]>(r.commands, []),
    scope: parse<VerifyScope | null>(r.scope, null),
    startedAt: Number(r.started_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
  }
}

function persistAndBroadcast(result: VerifyResult): void {
  verifyResultsDb.upsertVerifyResult.run({
    runId: result.runId,
    status: result.status,
    reason: result.reason,
    commands: JSON.stringify(result.commands),
    scope: result.scope === null ? null : JSON.stringify(result.scope),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  })
  eventBus.broadcast({ type: 'verify_update', result })
}

/** Kill a spawned shell AND its descendants. execa's own `timeout` signals only
 *  the direct child (cmd.exe / sh); a surviving grandchild keeps the `all` pipes
 *  open and the await hangs forever — the same failure fixed for the ollama Bash
 *  tool at f49e45e (native-tools.ts killTree). win32: taskkill /T walks the tree.
 *  POSIX: the shell is spawned `detached` (group leader) so kill(-pid) takes the
 *  whole group; fall back to the bare pid if the group is gone. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

/** Run ONE recipe command via a shell in `cwd`. Operator-authored shell strings —
 *  the same trust level as CI config. Never throws. */
export async function runRecipeCommand(
  cmd: { label: string; run: string },
  cwd: string,
  timeoutMs: number,
): Promise<VerifyCommandResult> {
  const started = Date.now()
  try {
    const subprocess = execa(cmd.run, {
      cwd, shell: true, reject: false, all: true,
      // POSIX only: group-leader so killTree can SIGKILL the whole tree.
      // (On win32, detached would allocate a new console; taskkill covers it.)
      detached: process.platform !== 'win32',
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(subprocess.pid) }, timeoutMs)
    const res = await subprocess.finally(() => clearTimeout(timer))
    let outputTail = (res.all ?? '').slice(-OUTPUT_TAIL_CHARS)
    if (timedOut) outputTail = `${outputTail}\nCommand timed out after ${timeoutMs}ms`.slice(-OUTPUT_TAIL_CHARS)
    return {
      label: cmd.label, run: cmd.run,
      exitCode: timedOut ? null : (res.exitCode ?? null),
      ok: !timedOut && res.exitCode === 0,
      durationMs: Date.now() - started,
      outputTail,
    }
  } catch (e) {
    return {
      label: cmd.label, run: cmd.run, exitCode: null, ok: false,
      durationMs: Date.now() - started,
      outputTail: String((e as Error).message).slice(-OUTPUT_TAIL_CHARS),
    }
  }
}

/** Full verify pass for one finished run. Persists+broadcasts running → terminal. */
export async function verifyRun(run: { id: string }, project: Project): Promise<VerifyResult> {
  const recipe = project.verifyRecipe
  const startedAt = Date.now()
  const running: VerifyResult = {
    runId: run.id, status: 'running', reason: null, commands: [], scope: null, startedAt, completedAt: null,
  }
  persistAndBroadcast(running)

  const finish = (patch: Partial<VerifyResult>): VerifyResult => {
    const done: VerifyResult = { ...running, ...patch, completedAt: Date.now() }
    persistAndBroadcast(done)
    return done
  }

  if (!recipe) return finish({ status: 'skipped', reason: 'no verify recipe' }) // defensive; trigger filters this
  const ckpts = listRunCheckpoints(run.id)
  if (ckpts.length === 0) return finish({ status: 'skipped', reason: 'no checkpointed changes' })

  const head = ckpts[ckpts.length - 1].sha
  // Created INSIDE the try: a throw here (disk full, perms) must still reach
  // finish({status:'error'}) — otherwise the row would sit at 'running' forever.
  let tmp: string | null = null
  let wt: string | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k-verify-'))
    wt = path.join(tmp, 'wt')
    // ── change scope (files always; symbols where indexed) ────────────────────
    const baseSha = (await execa('git', ['-C', project.localPath, 'rev-parse', `${ckpts[0].sha}^`], GIT_BOUND)).stdout.trim()
    const nameOnly = (await execa('git', ['-C', project.localPath, 'diff', '--name-only', baseSha, head], GIT_BOUND)).stdout
    const files = nameOnly.split('\n').map(s => s.trim()).filter(Boolean)
    let scope: VerifyScope = { files, symbols: null, indexed: false }
    if (isProjectIndexed(project.localPath)) {
      const graph = loadGraphJson(project.localPath)
      scope = graph
        ? { files, symbols: scopeForFiles(graph, files).reduce((s, f) => s + f.symbols.length, 0), indexed: true }
        : { files, symbols: null, indexed: true }
    }

    // ── battery in a FRESH worktree at the final checkpoint ───────────────────
    await execa('git', ['-C', project.localPath, 'worktree', 'add', '--detach', wt, head], GIT_BOUND)
    const commands: VerifyCommandResult[] = []
    for (const cmd of recipe.commands) {
      commands.push(await runRecipeCommand(cmd, wt, recipe.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS))
    }
    return finish({ status: commands.every(c => c.ok) ? 'pass' : 'fail', commands, scope })
  } catch (e) {
    return finish({ status: 'error', reason: String((e as Error).message).slice(0, 500) })
  } finally {
    if (wt) await execa('git', ['-C', project.localPath, 'worktree', 'remove', '--force', wt], GIT_BOUND).catch(() => undefined)
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
}

/**
 * Subscribe the engine to run terminals (mirrors registerGraphAutoReindex).
 * Fires ONLY for status 'done' + a projectId + a recipe-bearing, on-disk project.
 * Returns the unsubscribe.
 */
export function registerRunVerify(resolveProject: (id: string) => Project | null): () => void {
  return eventBus.onRunUpdate((run: Run) => {
    if (run.status !== 'done' || !run.projectId) return
    if (inFlight.has(run.id)) return
    const project = resolveProject(run.projectId)
    if (!project?.verifyRecipe || project.pathMissing) return
    inFlight.add(run.id)
    void verifyRun(run, project)
      .catch(err => console.warn(`[run-verify] verify failed (run ${run.id}):`, (err as Error).message))
      .finally(() => inFlight.delete(run.id))
  })
}
