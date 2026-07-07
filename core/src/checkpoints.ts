/**
 * k-checkpoint commits (P0 Lane B — E-03 rewind groundwork).
 *
 * After each completed tool wave the supervisor snapshots the run worktree as
 * a COMMIT OBJECT built entirely with plumbing:
 *   temp GIT_INDEX_FILE ← read-tree HEAD → add -A → write-tree
 *   → commit-tree <tree> -p <parent> → update-ref refs/k-checkpoints/<runId>
 *
 * ISOLATION GUARANTEE (the P0 decision): HEAD, the worktree's REAL index, and
 * every branch are untouched. K's PR path is agent-driven — the lead charter
 * tells the agent to branch + `gh pr create` (chief-dispatch.ts); core never
 * builds PR commits — and a branch the agent creates starts at the untouched
 * HEAD, so a checkpoint commit can NEVER reach a PR. Checkpoints CHAIN
 * (wave N's parent is wave N-1; wave 1's parent is the base HEAD) under ONE
 * ref per run, refs/k-checkpoints/<runId>, so every wave stays GC-reachable
 * and the P1 scrubber can walk the chain. Rejected alternatives: committing
 * on the detached HEAD (later agent branches would inherit checkpoints → PR
 * pollution); squash-before-PR (core doesn't own the PR moment — no reliable
 * squash hook exists).
 *
 * Refs deliberately OUTLIVE the run (the worktree is removed at terminal, the
 * shared object DB + refs live in the main repo): the P1 scrubber lists a
 * finished run's checkpoints from its events and can still `git show` them.
 * Pruning old checkpoint refs is future work (P1 owns the retention policy).
 */
import { execa } from 'execa'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface CheckpointInfo {
  sha: string
  tree: string
  ref: string
  wave: number
}

// Deterministic identity: checkpoint commits must never depend on (or leak)
// the host git identity, and must work where none is configured.
const IDENT_ENV = {
  GIT_AUTHOR_NAME: 'k-checkpoint',
  GIT_AUTHOR_EMAIL: 'k-checkpoint@k.local',
  GIT_COMMITTER_NAME: 'k-checkpoint',
  GIT_COMMITTER_EMAIL: 'k-checkpoint@k.local',
}

/**
 * Snapshot `worktree` as checkpoint `wave` for `runId`. Returns the commit
 * info, or null when the tree is IDENTICAL to the previous checkpoint (or to
 * the base HEAD for the first wave) — nothing changed, no commit is created,
 * and the caller must NOT consume the wave number. Never touches HEAD or the
 * real index. Throws on git failure — the supervisor catches + logs (a
 * checkpoint failure must never kill a run).
 */
export async function createCheckpoint(
  worktree: string,
  runId: string,
  wave: number,
  prev: CheckpointInfo | null,
): Promise<CheckpointInfo | null> {
  const tmpIndex = path.join(os.tmpdir(), `k-ckpt-${runId}-${wave}-${Date.now()}.idx`)
  // execa merges env over process.env by default, so git/gh auth etc. survive.
  const env = { ...IDENT_ENV, GIT_INDEX_FILE: tmpIndex }
  try {
    // Stage the CURRENT worktree state into the throwaway index (never the real one).
    await execa('git', ['-C', worktree, 'read-tree', 'HEAD'], { env })
    await execa('git', ['-C', worktree, 'add', '-A'], { env })
    const tree = (await execa('git', ['-C', worktree, 'write-tree'], { env })).stdout.trim()

    // Skip identical snapshots.
    if (prev !== null && tree === prev.tree) return null
    if (prev === null) {
      const headTree = (await execa('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}'])).stdout.trim()
      if (tree === headTree) return null
    }

    const parent = prev !== null
      ? prev.sha
      : (await execa('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    const msg = `k-checkpoint: ${runId} wave ${wave}`
    const sha = (
      await execa('git', ['-C', worktree, 'commit-tree', tree, '-p', parent, '-m', msg], { env })
    ).stdout.trim()
    const ref = `refs/k-checkpoints/${runId}`
    await execa('git', ['-C', worktree, 'update-ref', ref, sha])
    return { sha, tree, ref, wave }
  } finally {
    try { fs.unlinkSync(tmpIndex) } catch { /* best-effort */ }
  }
}
