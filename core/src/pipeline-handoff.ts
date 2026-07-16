/**
 * Per-edge handoff — the base-commit computation the engine (wave A3) uses to fork
 * each stage's worktree (D-119 Lane A, wave A2). Handoff is choosing WHERE a stage
 * forks from (§3):
 *   - `share-tree` → continue where the upstream stage left off (its result_commit).
 *   - `branch`     → fork at the pipeline base (isolated parallel siblings).
 *   - `merge`      → a plumbing 3-way merge of the inbound branches' result_commits;
 *                    the merge SHA becomes the target's base. NEVER auto-resolve a
 *                    conflict — surface it so the engine routes to repair/gate/agent.
 *
 * Pure git plumbing (no run, no agent) in an EPHEMERAL scratch worktree; the source
 * repo's HEAD/index/branches are never touched.
 */

import { execa } from 'execa'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { HandoffMode, EdgeWhen } from '@k/shared'
import { addDetachedWorktree, removeWorktreeWithRetry } from './supervisor.js'
import type { PipelineStageRow } from './pipeline-executor.js'

/** A materialized `pipeline_edges` row (the DDL columns, verbatim; db.ts:757).
 *  from_stage_key NULL = an entry edge. Edges reference stages by their stable slug
 *  (stage_key), which is why resolveBaseCommit is handed a by-KEY stage map. */
export interface PipelineEdgeRow {
  id: string
  pipeline_run_id: string
  from_stage_key: string | null
  to_stage_key: string
  handoff: HandoffMode
  when_cond: EdgeWhen
}

/** The computed fork point for a target stage: either a single base commit
 *  (share-tree / branch / entry), or a set of branch tips to fan-in 3-way merge
 *  (the engine then calls mergeBranches). */
export type BaseResolution = { base: string } | { merge: string[] }

/** The terminal snapshot an inbound stage handed off — its result_commit, else its
 *  fork base, else the pipeline base (a not-yet-passed source; at handoff time an
 *  inbound stage is normally passed and carries a result_commit). */
function inboundResult(
  edge: PipelineEdgeRow,
  fromStageByKey: Map<string, PipelineStageRow>,
  pipelineBaseCommit: string,
): string {
  const from = edge.from_stage_key != null ? fromStageByKey.get(edge.from_stage_key) : undefined
  return from?.result_commit ?? from?.base_commit ?? pipelineBaseCommit
}

/**
 * Compute a target stage's base from its INCOMING edges (`edgesInto`).
 * `fromStageByKey` maps each source stage_key → its row (for result_commit lookup).
 *
 * - no real inbound edge (entry / all from NULL) → the pipeline base.
 * - 2+ inbound `merge` edges converge → { merge: [tipA, tipB, …] } (fan-in join).
 * - otherwise a single dominant inbound edge governs (a lone `merge` edge included):
 *     branch → the pipeline base;  merge → { merge: [tip] };
 *     share-tree (default) → the upstream result_commit (base fallbacks apply).
 */
export function resolveBaseCommit(
  edgesInto: PipelineEdgeRow[],
  fromStageByKey: Map<string, PipelineStageRow>,
  pipelineBaseCommit: string,
): BaseResolution {
  const real = edgesInto.filter(e => e.from_stage_key != null)
  if (real.length === 0) return { base: pipelineBaseCommit }

  // Fan-in: multiple inbound merge edges → 3-way merge of their source tips.
  const mergeEdges = real.filter(e => e.handoff === 'merge')
  if (mergeEdges.length >= 2) {
    return { merge: mergeEdges.map(e => inboundResult(e, fromStageByKey, pipelineBaseCommit)) }
  }

  // Single dominant inbound edge (prefer a lone merge edge if one is present).
  const edge = mergeEdges[0] ?? real[0]
  switch (edge.handoff) {
    case 'branch':
      return { base: pipelineBaseCommit }
    case 'merge':
      return { merge: [inboundResult(edge, fromStageByKey, pipelineBaseCommit)] }
    case 'share-tree':
    default:
      return { base: inboundResult(edge, fromStageByKey, pipelineBaseCommit) }
  }
}

// Deterministic identity for the merge commit — never depends on (or leaks) the host
// git identity, and works where none is configured. Mirrors checkpoints.ts::IDENT_ENV.
// execa merges this over process.env (extendEnv default), so git/gh auth etc. survive.
const MERGE_IDENT_ENV = {
  GIT_AUTHOR_NAME: 'k-pipeline-merge',
  GIT_AUTHOR_EMAIL: 'k-pipeline-merge@k.local',
  GIT_COMMITTER_NAME: 'k-pipeline-merge',
  GIT_COMMITTER_EMAIL: 'k-pipeline-merge@k.local',
}
const GIT_BOUND = { timeout: 60_000, killSignal: 'SIGKILL' as const }

/**
 * Fan-in 3-way merge: fork an EPHEMERAL scratch worktree at `pipelineBaseCommit` and
 * `git merge --no-ff --no-edit` each result commit in turn. Clean → the merge SHA
 * (`{ mergedSha }`). Any merge failure (a real conflict, or e.g. a bad SHA) → abort,
 * NEVER auto-resolve, and return `{ conflict: true, detail }`. The scratch worktree is
 * always removed (finally). The source repo's HEAD/branches are untouched.
 */
export async function mergeBranches(
  pipelineBaseCommit: string,
  resultCommits: string[],
  cwd: string,
): Promise<{ mergedSha: string } | { conflict: true; detail: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-merge-'))
  const wt = path.join(tmp, 'wt')
  try {
    await addDetachedWorktree(cwd, wt, pipelineBaseCommit)
    for (const sha of resultCommits) {
      const res = await execa('git', ['-C', wt, 'merge', '--no-ff', '--no-edit', sha], {
        env: MERGE_IDENT_ENV, reject: false, ...GIT_BOUND,
      })
      if (res.exitCode !== 0) {
        const detail = `merge of ${sha.slice(0, 12)} into the fan-in tree failed: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`
        // NEVER auto-resolve — abort the in-progress merge and surface the conflict.
        await execa('git', ['-C', wt, 'merge', '--abort'], { reject: false, ...GIT_BOUND })
        return { conflict: true, detail }
      }
    }
    const mergedSha = (await execa('git', ['-C', wt, 'rev-parse', 'HEAD'], GIT_BOUND)).stdout.trim()
    return { mergedSha }
  } finally {
    await removeWorktreeWithRetry(() =>
      execa('git', ['-C', cwd, 'worktree', 'remove', '--force', wt]).then(() => undefined),
    )
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}
