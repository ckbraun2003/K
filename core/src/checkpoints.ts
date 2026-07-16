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
 * Retention: the boot sweep (`sweepCheckpointRefs`, below) deletes refs whose
 * run rows are gone — see its single-core-per-repo assumption.
 */
import { execa } from 'execa'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eventsDb } from './db.js'

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
  // Every call is time-bounded: the supervisor awaits this chain in BOTH
  // terminal paths, so a wedged git child (FS/AV stall) must reject (caught +
  // logged by scheduleCheckpoint) rather than block run finalization and kill.
  const env = { ...IDENT_ENV, GIT_INDEX_FILE: tmpIndex }
  const bounded = { timeout: 30_000, killSignal: 'SIGKILL' as const }
  try {
    // Stage the CURRENT worktree state into the throwaway index (never the real one).
    await execa('git', ['-C', worktree, 'read-tree', 'HEAD'], { env, ...bounded })
    await execa('git', ['-C', worktree, 'add', '-A'], { env, ...bounded })
    const tree = (await execa('git', ['-C', worktree, 'write-tree'], { env, ...bounded })).stdout.trim()

    // Skip identical snapshots.
    if (prev !== null && tree === prev.tree) return null
    if (prev === null) {
      const headTree = (await execa('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}'], bounded)).stdout.trim()
      if (tree === headTree) return null
    }

    const parent = prev !== null
      ? prev.sha
      : (await execa('git', ['-C', worktree, 'rev-parse', 'HEAD'], bounded)).stdout.trim()
    const msg = `k-checkpoint: ${runId} wave ${wave}`
    const sha = (
      await execa('git', ['-C', worktree, 'commit-tree', tree, '-p', parent, '-m', msg], { env, ...bounded })
    ).stdout.trim()
    const ref = `refs/k-checkpoints/${runId}`
    await execa('git', ['-C', worktree, 'update-ref', ref, sha], bounded)
    return { sha, tree, ref, wave }
  } finally {
    try { fs.unlinkSync(tmpIndex) } catch { /* best-effort */ }
  }
}

// ─── P1: durable checkpoint listing (scrubber / diff / verify / rewind) ───────

export interface StoredCheckpoint {
  sha: string
  tree: string
  ref: string
  wave: number
  seq: number
  ts: number
}

/**
 * List a run's checkpoints from its persisted `checkpoint` events (seq order).
 * The events table is the DURABLE source — worktrees are removed at terminal,
 * but the events (and the refs in the shared .git) live on. Defensive: an event
 * with malformed/missing raw is skipped, never a throw.
 */
export function listRunCheckpoints(runId: string): StoredCheckpoint[] {
  const rows = eventsDb.listCheckpointEvents.all(runId) as Array<{ seq: number; ts: number; raw: string | null }>
  const out: StoredCheckpoint[] = []
  for (const r of rows) {
    if (r.raw == null) continue
    try {
      const raw = JSON.parse(r.raw) as { sha?: unknown; tree?: unknown; ref?: unknown; wave?: unknown }
      if (typeof raw.sha !== 'string' || typeof raw.wave !== 'number') continue
      out.push({
        sha: raw.sha,
        tree: typeof raw.tree === 'string' ? raw.tree : '',
        ref: typeof raw.ref === 'string' ? raw.ref : `refs/k-checkpoints/${runId}`,
        wave: raw.wave,
        seq: Number(r.seq),
        ts: Number(r.ts),
      })
    } catch { /* skip malformed */ }
  }
  return out
}

// ─── P1: tool-wave scheduler + terminal snapshot (P0 carry-in #1) ─────────────

/**
 * The supervisor's checkpoint scheduling, extracted so the boundary/terminal
 * logic is unit-testable without spawning a CLI. Semantics preserved from P0:
 * `onBoundary` is take-latest (a boundary while a snapshot is in flight is
 * dropped — the next snapshot re-captures everything). NEW: `finalize()` settles
 * the chain then takes ONE terminal snapshot, so the run's FINAL state is always
 * reachable even when the last boundary was dropped or the run was killed
 * mid-wave. Identical-tree dedup (createCheckpoint → null) makes the terminal
 * snapshot commit-free when the last boundary already captured it. Cost: one
 * extra `add -A` tree hash per worktree run at terminal — the accepted re-hash
 * posture (P0 carry-in #3), documented as accepted.
 */
export function makeCheckpointScheduler(opts: {
  worktree: string
  runId: string
  emit: (info: CheckpointInfo) => void
  create?: typeof createCheckpoint
}): { onBoundary: () => void; finalize: () => Promise<CheckpointInfo | null>; last: () => CheckpointInfo | null } {
  const create = opts.create ?? createCheckpoint
  let lastCheckpoint: CheckpointInfo | null = null
  let busy = false
  let chain: Promise<void> = Promise.resolve()

  const snapshot = async (): Promise<void> => {
    try {
      const wave = (lastCheckpoint?.wave ?? 0) + 1
      const res = await create(opts.worktree, opts.runId, wave, lastCheckpoint)
      if (res !== null) {
        lastCheckpoint = res
        opts.emit(res)
      }
    } catch (err) {
      // A checkpoint failure must never kill the run — log and continue.
      console.warn(`[checkpoints] snapshot failed (run ${opts.runId}):`, (err as Error).message)
    } finally {
      busy = false
    }
  }

  return {
    onBoundary(): void {
      if (busy) return // take-latest; finalize() recovers anything dropped here
      busy = true
      chain = chain.then(snapshot)
    },
    async finalize(): Promise<CheckpointInfo | null> {
      await chain // settle in-flight work first
      busy = true
      await (chain = chain.then(snapshot)) // terminal snapshot (dedup no-ops when clean)
      return lastCheckpoint
    },
    last: () => lastCheckpoint,
  }
}

// ─── P1: checkpoint-ref retention (P0 carry-in #2) ────────────────────────────

/**
 * Boot sweep: delete `refs/k-checkpoints/<runId>` refs whose runs row no longer
 * exists. Refs deliberately OUTLIVE runs (the scrubber reads finished runs), but
 * a DELETED run needs none — without this they accumulate forever. Best-effort +
 * bounded: any git failure logs-and-continues; a non-repo root is skipped;
 * duplicate roots (case-folded) are visited once. Returns refs deleted.
 *
 * ASSUMPTION (single core per repo — P1 SEAMS M1): ref existence is checked
 * against THIS instance's DB only. Two cores with separate K_DATA_DIRs sharing
 * one repo (a dev second instance, e2e swarms) could sweep each other's LIVE
 * chains at boot — losing diff/rewind/verify bases (recoverable by re-running;
 * no committed work is touched). The instance lock is per-data-dir, so this is
 * not mechanically prevented; a cross-instance guard lands with the fleet work
 * (P7). Until then: one core per repo checkout.
 */
export async function sweepCheckpointRefs(
  repoRoots: string[],
  runExists: (runId: string) => boolean,
): Promise<number> {
  const bounded = { timeout: 30_000, killSignal: 'SIGKILL' as const }
  const seen = new Set<string>()
  let deleted = 0
  for (const root of repoRoots) {
    const key = path.resolve(root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const { stdout } = await execa(
        'git', ['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/k-checkpoints/'], bounded,
      )
      for (const ref of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
        const runId = ref.slice('refs/k-checkpoints/'.length)
        if (runId === '' || runExists(runId)) continue
        try {
          await execa('git', ['-C', root, 'update-ref', '-d', ref], bounded)
          deleted++
        } catch { /* best-effort per ref */ }
      }
    } catch { /* not a git repo / git unavailable — skip this root */ }
  }
  return deleted
}

/**
 * Boot sweep for PIPELINE handoff refs (D-119, A3). A stage's deterministic handoff
 * commit lives at `refs/k-pipelines/<pipelineRunId>/<stageKey>` — a namespace immune to
 * the RUN-keyed `sweepCheckpointRefs` above (which scans only `refs/k-checkpoints/`), so
 * a handoff commit is NOT orphaned when its stage's run row is swept mid-pipeline. This
 * mirror sweep is keyed on `pipeline_runs` existence instead: it deletes refs whose
 * `<pipelineRunId>` segment names a pipeline run that no longer exists (deleted/cascaded).
 * Same best-effort + bounded + dedup-roots posture (and the same single-core-per-repo
 * assumption) as sweepCheckpointRefs. Returns refs deleted.
 */
export async function sweepPipelineRefs(
  repoRoots: string[],
  pipelineRunExists: (pipelineRunId: string) => boolean,
): Promise<number> {
  const bounded = { timeout: 30_000, killSignal: 'SIGKILL' as const }
  const seen = new Set<string>()
  let deleted = 0
  for (const root of repoRoots) {
    const key = path.resolve(root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const { stdout } = await execa(
        'git', ['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/k-pipelines/'], bounded,
      )
      for (const ref of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
        // refs/k-pipelines/<pipelineRunId>/<stageKey> — key on the first segment. stageKey
        // is [a-z0-9-] (no slash), so the split is unambiguous.
        const pipelineRunId = ref.slice('refs/k-pipelines/'.length).split('/')[0]
        if (pipelineRunId === '' || pipelineRunExists(pipelineRunId)) continue
        try {
          await execa('git', ['-C', root, 'update-ref', '-d', ref], bounded)
          deleted++
        } catch { /* best-effort per ref */ }
      }
    } catch { /* not a git repo / git unavailable — skip this root */ }
  }
  return deleted
}
