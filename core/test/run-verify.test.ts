/**
 * P1 B1 — E-04 recipe engine: pass/fail against a REAL temp repo + checkpoints
 * (no claude spawn; commands are `node -e` one-liners), skipped-degrade, and the
 * registerRunVerify trigger filter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project } from '@k/shared'
import { runsDb, eventsDb, verifyResultsDb } from '../src/db.js'
import { createCheckpoint, type CheckpointInfo } from '../src/checkpoints.js'
import { verifyRun, runRecipeCommand, rowToVerifyResult, registerRunVerify } from '../src/run-verify.js'
import { eventBus } from '../src/events.js'

let base: string
let repo: string
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }

function project(recipe: Project['verifyRecipe']): Project {
  return {
    id: randomUUID(), name: `vp-${Date.now()}`, localPath: repo, workspaceManaged: false,
    bibleDir: 'artifacts/bible', createdAt: Date.now(),
    ...(recipe === undefined ? {} : { verifyRecipe: recipe }),
  } as Project
}

async function seededRun(): Promise<string> {
  const rid = randomUUID()
  runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: repo, worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
  const wt = path.join(base, `wt-${rid.slice(0, 8)}`)
  git(repo, ['worktree', 'add', '--detach', wt])
  fs.writeFileSync(path.join(wt, 'change.txt'), 'agent work\n')
  const w1 = (await createCheckpoint(wt, rid, 1, null)) as CheckpointInfo
  eventsDb.insertEvent.run({ id: randomUUID(), runId: rid, seq: 4, type: 'checkpoint', ts: Date.now(),
    raw: JSON.stringify({ sha: w1.sha, tree: w1.tree, ref: w1.ref, wave: 1 }),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
    toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
    subagentType: null, childLabel: null, contextTokens: null })
  git(repo, ['worktree', 'remove', '--force', wt])
  return rid
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-verify-t-'))
  repo = path.join(base, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@k']); git(repo, ['config', 'user.name', 'K'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init'])
})
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* */ } })

describe('runRecipeCommand', () => {
  it('captures exit code, duration, output tail; never throws', async () => {
    const ok = await runRecipeCommand({ label: 'ok', run: 'node -e "console.log(1+1)"' }, repo, 60_000)
    expect(ok).toMatchObject({ ok: true, exitCode: 0 })
    expect(ok.outputTail).toContain('2')
    const bad = await runRecipeCommand({ label: 'bad', run: 'node -e "process.exit(3)"' }, repo, 60_000)
    expect(bad).toMatchObject({ ok: false, exitCode: 3 })
  })

  it('kills the whole process tree on timeout instead of hanging', async () => {
    // Mirrors the f49e45e ollama Bash regression: execa's own `timeout` signals
    // only the direct shell; the killTree path must resolve the await anyway.
    const res = await runRecipeCommand({ label: 'hang', run: 'node -e "setTimeout(() => {}, 60000)"' }, repo, 500)
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBeNull()
    expect(res.outputTail).toMatch(/timed out after 500ms/)
  }, 20_000)
})

describe('verifyRun', () => {
  it('pass: battery runs in a FRESH worktree at the final checkpoint', async () => {
    const rid = await seededRun()
    const res = await verifyRun({ id: rid }, project({
      commands: [{ label: 'sees-change', run: 'node -e "require(\'fs\').accessSync(\'change.txt\')"' }],
    }))
    expect(res.status).toBe('pass')
    expect(res.scope).toMatchObject({ files: ['change.txt'], indexed: false })
    const stored = rowToVerifyResult(verifyResultsDb.getVerifyResult.get(rid) as Record<string, unknown>)
    expect(stored.status).toBe('pass')
    expect(stored.commands[0].ok).toBe(true)
  })

  it('fail: any non-zero command fails the battery (later commands still run)', async () => {
    const rid = await seededRun()
    const res = await verifyRun({ id: rid }, project({
      commands: [
        { label: 'fails', run: 'node -e "process.exit(1)"' },
        { label: 'passes', run: 'node -e "process.exit(0)"' },
      ],
    }))
    expect(res.status).toBe('fail')
    expect(res.commands).toHaveLength(2)
    expect(res.commands[1].ok).toBe(true)
  })

  it('skipped: a run with no checkpoints', async () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    const res = await verifyRun({ id: rid }, project({ commands: [{ label: 't', run: 'node -e ""' }] }))
    expect(res.status).toBe('skipped')
    expect(res.reason).toContain('no checkpointed changes')
  })

  it('broadcasts verify_update running → terminal', async () => {
    const seen: string[] = []
    const off = eventBus.onBroadcast(m => { if (m.type === 'verify_update') seen.push(m.result.status) })
    const rid = await seededRun()
    await verifyRun({ id: rid }, project({ commands: [{ label: 't', run: 'node -e ""' }] }))
    off()
    expect(seen[0]).toBe('running')
    expect(seen[seen.length - 1]).toBe('pass')
  })
})

describe('registerRunVerify trigger', () => {
  it('ignores non-done runs, no-project runs, and recipe-less projects', async () => {
    const calls: string[] = []
    // resolveProject returning null ⇒ recipe-less ⇒ must not verify
    const off = registerRunVerify(() => { calls.push('resolved'); return null })
    eventBus.emitRunUpdate({ id: randomUUID(), prompt: 'x', cwd: repo, status: 'error', provider: 'claude',
      model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now() } as never)
    off()
    expect(calls).toHaveLength(0) // error status never even resolves the project
  })
})
