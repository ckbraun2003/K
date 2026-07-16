/**
 * D-119 Lane A / wave A2 — pipeline-handoff (base-commit resolution + fan-in merge).
 *
 * resolveBaseCommit is pure (constructed rows). mergeBranches is real git against a
 * throwaway repo. Proves:
 *   a) resolveBaseCommit picks share-tree (upstream result) / branch (pipeline base) /
 *      merge (fan-in tips) / entry (pipeline base) correctly;
 *   b) mergeBranches of two branches touching DIFFERENT files → a merge SHA whose tree
 *      carries both changes (source HEAD untouched);
 *   c) two branches touching the SAME line → { conflict: true } (never auto-resolved).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBaseCommit, mergeBranches, type PipelineEdgeRow } from '../src/pipeline-handoff.js'
import type { PipelineStageRow } from '../src/pipeline-executor.js'

const bases: string[] = []
let repo: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A materialized stage row with only the columns handoff reads populated. */
function stageRow(over: Partial<PipelineStageRow> & Pick<PipelineStageRow, 'stage_key'>): PipelineStageRow {
  const now = Date.now()
  return {
    id: `id-${over.stage_key}`,
    pipeline_run_id: 'plr',
    kind: 'agent',
    profile_id: null,
    spec: '{}',
    status: 'passed',
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

function edge(over: Partial<PipelineEdgeRow> & Pick<PipelineEdgeRow, 'from_stage_key' | 'to_stage_key' | 'handoff'>): PipelineEdgeRow {
  return { id: `e-${Math.random().toString(36).slice(2)}`, pipeline_run_id: 'plr', when_cond: 'always', ...over }
}

/** Commit `files` on a fresh branch forked at baseCommit; return the new SHA. Leaves
 *  the repo checked back out at the base branch. */
function branchCommit(name: string, files: Record<string, string>): string {
  git(repo, ['checkout', '-q', '-b', name, baseCommit])
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), content)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', `on ${name}`])
  const sha = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['checkout', '-q', baseCommit])
  return sha
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-handoff-'))
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

describe('resolveBaseCommit', () => {
  const PB = 'PIPELINE_BASE'

  it('entry (no real inbound edge) → the pipeline base', () => {
    const res = resolveBaseCommit([edge({ from_stage_key: null, to_stage_key: 'a', handoff: 'share-tree' })], new Map(), PB)
    expect(res).toEqual({ base: PB })
  })

  it('single share-tree edge → the upstream stage result_commit', () => {
    const from = stageRow({ stage_key: 'impl', result_commit: 'RESULT_IMPL' })
    const res = resolveBaseCommit(
      [edge({ from_stage_key: 'impl', to_stage_key: 'review', handoff: 'share-tree' })],
      new Map([['impl', from]]), PB,
    )
    expect(res).toEqual({ base: 'RESULT_IMPL' })
  })

  it('share-tree with no result yet → base_commit then pipeline base', () => {
    const noResult = stageRow({ stage_key: 'impl', base_commit: 'IMPL_BASE' })
    expect(resolveBaseCommit(
      [edge({ from_stage_key: 'impl', to_stage_key: 'r', handoff: 'share-tree' })],
      new Map([['impl', noResult]]), PB,
    )).toEqual({ base: 'IMPL_BASE' })
    // absent from the map entirely → pipeline base
    expect(resolveBaseCommit(
      [edge({ from_stage_key: 'ghost', to_stage_key: 'r', handoff: 'share-tree' })],
      new Map(), PB,
    )).toEqual({ base: PB })
  })

  it('single branch edge → the pipeline base (isolated sibling)', () => {
    const from = stageRow({ stage_key: 'plan', result_commit: 'RESULT_PLAN' })
    const res = resolveBaseCommit(
      [edge({ from_stage_key: 'plan', to_stage_key: 'impl', handoff: 'branch' })],
      new Map([['plan', from]]), PB,
    )
    expect(res).toEqual({ base: PB })
  })

  it('multiple inbound merge edges → { merge: [tipA, tipB] }', () => {
    const a = stageRow({ stage_key: 'fe', result_commit: 'TIP_FE' })
    const b = stageRow({ stage_key: 'be', result_commit: 'TIP_BE' })
    const res = resolveBaseCommit([
      edge({ from_stage_key: 'fe', to_stage_key: 'merge', handoff: 'merge' }),
      edge({ from_stage_key: 'be', to_stage_key: 'merge', handoff: 'merge' }),
    ], new Map([['fe', a], ['be', b]]), PB)
    expect(res).toEqual({ merge: ['TIP_FE', 'TIP_BE'] })
  })
})

describe('mergeBranches', () => {
  it('b) merges two branches touching different files → both changes present', async () => {
    const sha1 = branchCommit('b1', { 'b.txt': 'bbb\n' })
    const sha2 = branchCommit('b2', { 'c.txt': 'ccc\n' })
    const res = await mergeBranches(baseCommit, [sha1, sha2], repo)
    expect('mergedSha' in res).toBe(true)
    if (!('mergedSha' in res)) throw new Error('expected a clean merge')
    // The merged tree carries the base file plus both divergent files.
    const tree = git(repo, ['ls-tree', '-r', '--name-only', res.mergedSha])
    expect(tree).toContain('a.txt')
    expect(tree).toContain('b.txt')
    expect(tree).toContain('c.txt')
    expect(git(repo, ['show', `${res.mergedSha}:b.txt`])).toBe('bbb\n')
    expect(git(repo, ['show', `${res.mergedSha}:c.txt`])).toBe('ccc\n')
    // Source repo HEAD is untouched (ephemeral scratch worktree only).
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit)
  })

  it('c) two branches touching the same line → { conflict: true } (never auto-resolved)', async () => {
    const sha1 = branchCommit('c1', { 'a.txt': 'CONFLICT-ONE\n' })
    const sha2 = branchCommit('c2', { 'a.txt': 'CONFLICT-TWO\n' })
    const res = await mergeBranches(baseCommit, [sha1, sha2], repo)
    expect(res).toHaveProperty('conflict', true)
    if (!('conflict' in res)) throw new Error('expected a conflict')
    expect(res.detail).toBeTruthy()
    // HEAD untouched; no dangling merge state in the source repo.
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit)
  })
})
