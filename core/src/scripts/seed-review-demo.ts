/**
 * Dev diff-seed fixture (BE-6). Seeds a throwaway project + one COMPLETED run whose
 * k-checkpoint chain carries a real 3-file diff (modify + add in wave 1, modify in
 * wave 2), so the Changes surface / DiffViewer v2 can be screenshot-verified without
 * paying for a live dispatch. Uses the REAL createCheckpoint plumbing — the diff the
 * UI renders is byte-honest git output, not a mock.
 *
 * Invoke (dev stack may be up or down; single short write txns):
 *   pnpm --filter @k/core seed:review-demo
 * Then open #/runs → "Seed: review demo run" → Changes.
 * Idempotent: re-running wipes and re-seeds. Remove via the UI (delete project) or re-run.
 * NEVER wired into boot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
// DATA_DIR is db.ts's own resolution (K_DATA_DIR override, else <repo>/data) — the
// seed repo must live beside the DB it is registered in, so import it rather than
// re-deriving the path here.
import { db, runsDb, eventsDb, projectsDb, DATA_DIR } from '../db.js'
import { createCheckpoint } from '../checkpoints.js'

const RUN_ID = 'seed-review-demo-run'
const PROJECT_ID = 'seed-review-demo'

const repo = path.join(DATA_DIR, 'seed-review-demo', 'repo')

async function git(...args: string[]): Promise<string> {
  return (await execa('git', ['-C', repo, ...args], { timeout: 30_000 })).stdout
}

function insertCheckpointEvent(seq: number, ck: NonNullable<Awaited<ReturnType<typeof createCheckpoint>>>): void {
  eventsDb.insertEvent.run({
    id: randomUUID(), runId: RUN_ID, seq, type: 'checkpoint', ts: Date.now(),
    raw: JSON.stringify(ck), text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null,
    toolUseId: null, toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
    subagentType: null, childLabel: null, contextTokens: null,
  })
}

async function main(): Promise<void> {
  // 0. wipe any previous seed (FK order: events → runs → projects) + repo dir
  db.prepare(`DELETE FROM events WHERE run_id = ?`).run(RUN_ID)
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(RUN_ID)
  db.prepare(`DELETE FROM artifacts WHERE project_id = ?`).run(PROJECT_ID)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(PROJECT_ID)
  fs.rmSync(path.dirname(repo), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })

  // 1. real git repo with a base commit
  fs.mkdirSync(repo, { recursive: true })
  await execa('git', ['init', '-b', 'main', repo])
  await git('config', 'user.email', 'seed@k.local')
  await git('config', 'user.name', 'k-seed')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Seed review demo\n\nThrowaway fixture repo.\n')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'),
    Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i}`).join('\n') + '\n')
  await git('add', '-A')
  await git('commit', '-m', 'base')

  // 2. project + run rows (run cwd = the repo; status done so review surfaces enable)
  const now = Date.now()
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: 'Seed Review Demo', localPath: repo,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: now,
  })
  runsDb.insertRun.run({
    id: RUN_ID, prompt: 'Seed: review demo run — 3-file checkpoint diff for the Changes surface',
    cwd: repo, worktree: null, status: 'running', provider: 'claude', model: 'claude-sonnet-4-6',
    tokensIn: 1200, tokensOut: 800, costUsd: 0.0123, projectId: PROJECT_ID, createdAt: now - 10 * 60_000,
  })

  // 3. wave 1: modify app.ts mid-file + add a new module (2 files)
  const app = fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8').split('\n')
  app[14] = 'export const line14 = 1400 // reviewed change'
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), app.join('\n'))
  fs.writeFileSync(path.join(repo, 'src', 'new-module.ts'), 'export function fresh(): string {\n  return "added in wave 1"\n}\n')
  const ck1 = await createCheckpoint(repo, RUN_ID, 1, null)
  if (!ck1) throw new Error('wave 1 checkpoint produced no commit')
  insertCheckpointEvent(1, ck1)

  // 4. wave 2: modify README (3rd file)
  fs.appendFileSync(path.join(repo, 'README.md'), '\n## Wave 2\n\nSecond checkpointed edit.\n')
  const ck2 = await createCheckpoint(repo, RUN_ID, 2, ck1)
  if (!ck2) throw new Error('wave 2 checkpoint produced no commit')
  insertCheckpointEvent(2, ck2)

  // 5. finalize the run
  runsDb.updateRunStatus.run({ id: RUN_ID, status: 'done', tokensIn: 1200, tokensOut: 800, costUsd: 0.0123, endedAt: now })

  console.log(`[seed-review-demo] ready ✓`)
  console.log(`  project  ${PROJECT_ID}  →  ${repo}`)
  console.log(`  run      ${RUN_ID}  (done, 2 checkpoints, 3-file diff)`)
  console.log(`  view     #/runs → "Seed: review demo run" → Changes  ·  GET /api/runs/${RUN_ID}/diff`)
}

await main()
