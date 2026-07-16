/**
 * D-119 Lane A / wave A1 — WorktreeStageExecutor.
 *
 * Real git against a throwaway repo (no claude ever spawns — the agent path needs a
 * live model, so A1 exercises the zero-token stage kinds). Proves:
 *   a) a `command` deterministic stage runs in a fresh worktree forked at base_commit,
 *      settles passed, and its handoff resultCommit captures the change;
 *   b) a command that changes nothing → resultCommit falls back to base_commit;
 *   c) a failing command settles failed with its exit code;
 *   d) a `gate` stage parks (no run, no worktree);
 *   e) roleToProfileId maps the security discipline to its lead, else orchestrator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WorktreeStageExecutor,
  roleToProfileId,
  type PipelineStageRow,
  type StageContext,
} from '../src/pipeline-executor.js'

const bases: string[] = []
let repo: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A materialized stage row with just the columns the executor reads; the rest are
 *  filled with their DDL defaults so the shape is faithful. */
function stageRow(over: Partial<PipelineStageRow> & Pick<PipelineStageRow, 'kind' | 'spec'>): PipelineStageRow {
  const now = Date.now()
  return {
    id: `stage-${Math.random().toString(36).slice(2)}`,
    pipeline_run_id: 'plr-test',
    stage_key: 'test-stage',
    profile_id: null,
    status: 'pending',
    run_id: null,
    base_commit: null,
    result_commit: null,
    exit_code: null,
    failure_class: null,
    retry_count: 0,
    repair_stage_key: null,
    repairs_used: 0,
    gate_resolved_by: null,
    gate_note: null,
    cost_usd: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    ...over,
  }
}

/** Serialize an authoring StageDef object to the frozen `spec` string the row
 *  carries. Loosely typed: it is stored JSON the executor re-validates with
 *  StageDefSchema (which fills the hooks/injection/retry defaults) — exactly the
 *  authoring-input → parse round-trip production does. */
function spec(def: Record<string, unknown>): string {
  return JSON.stringify(def)
}

function ctx(stage: PipelineStageRow): StageContext {
  return { pipelineRunId: 'plr-test', stage, projectId: null, cwd: repo, baseCommit }
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-exec-'))
  bases.push(base)
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@k.local'])
  git(repo, ['config', 'user.name', 'K Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()
})

afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('WorktreeStageExecutor', () => {
  it('a) a command stage settles passed with a handoff commit capturing the change', async () => {
    const exec = new WorktreeStageExecutor()
    const stage = stageRow({
      kind: 'deterministic', base_commit: baseCommit,
      spec: spec({ id: 'write', label: 'S', kind: 'deterministic', action: { type: 'command', run: 'echo pipeline > stage-out.txt' } }),
    })
    const res = await exec.dispatch(ctx(stage))
    expect(res.kind).toBe('settled')
    if (res.kind !== 'settled') throw new Error('unreachable')
    expect(res.status).toBe('passed')
    expect(res.exitCode).toBe(0)
    // resultCommit is a NEW checkpoint commit (not the base) whose tree carries the file.
    expect(res.resultCommit).toBeTruthy()
    expect(res.resultCommit).not.toBe(baseCommit)
    expect(git(repo, ['cat-file', '-t', res.resultCommit!]).trim()).toBe('commit')
    expect(git(repo, ['ls-tree', '--name-only', res.resultCommit!])).toContain('stage-out.txt')
    // The source repo HEAD is untouched (isolation).
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit)
  })

  it('b) a no-op command falls back to base_commit (no change → no checkpoint)', async () => {
    const exec = new WorktreeStageExecutor()
    const stage = stageRow({
      kind: 'deterministic', base_commit: baseCommit,
      spec: spec({ id: 'noop', label: 'S', kind: 'deterministic', action: { type: 'command', run: 'echo hi' } }),
    })
    const res = await exec.dispatch(ctx(stage))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed')
    expect(res.resultCommit).toBe(baseCommit)
  })

  it('c) a failing command settles failed with its exit code', async () => {
    const exec = new WorktreeStageExecutor()
    const stage = stageRow({
      kind: 'deterministic', base_commit: baseCommit,
      spec: spec({ id: 'boom', label: 'S', kind: 'deterministic', action: { type: 'command', run: 'exit 1' } }),
    })
    const res = await exec.dispatch(ctx(stage))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('failed')
    expect(res.exitCode).toBe(1)
  })

  it('d) a gate stage parks (no run, no worktree)', async () => {
    const exec = new WorktreeStageExecutor()
    const stage = stageRow({
      kind: 'gate', base_commit: baseCommit,
      spec: spec({ id: 'approve', label: 'S', kind: 'gate', gate: { mode: 'manual', predicate: {} } }),
    })
    const res = await exec.dispatch(ctx(stage))
    expect(res).toEqual({ kind: 'parked', status: 'awaiting_gate' })
  })

  it('e) roleToProfileId maps security-review to its lead, else the orchestrator', () => {
    expect(roleToProfileId('security-review')).toBe('lead-security')
    expect(roleToProfileId('Orchestrator')).toBe('default-orchestrator')
    expect(roleToProfileId('implementer')).toBe('default-orchestrator')
    expect(roleToProfileId('anything-else')).toBe('default-orchestrator')
  })
})
