/**
 * P0 PHASE SMOKE — one scratch dispatch through the REAL core proving:
 *   1. checkpoint commits exist for the run (refs/k-checkpoints/<runId> in the
 *      K repo + a type:'checkpoint' event on the WS wire);
 *   2. runs.cli_session_id was captured (GET /api/runs/:id -> cliSessionId);
 *   3. canonical E-11 triples observed on the WS wire (run_update.run.canonical).
 *
 * Boots an ISOLATED core (scratch K_DATA_DIR, port 3210) from this checkout,
 * dispatches one cheap haiku run against the K repo root (fresh detached
 * worktree, discarded at run end — nothing user-visible changes), asserts, and
 * prints MEASURED cost (run.costUsd — CLI-reported, never estimated).
 *
 * PRECONDITION: stop every other K core first — this core's boot sweep prunes
 * k/.worktrees entries not owned by ITS process.
 * LIVE (~$0.01–$0.05 measured). NEVER runs in CI.
 * Run from core/:  pnpm exec tsx probes/smoke-p0.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORE_DIR = path.join(__dirname, '..')       // core/
const REPO_ROOT = path.join(__dirname, '../..')   // k/
const PORT = 3210
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const MODEL = 'claude-haiku-4-5-20251001'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-smoke-p0-'))

const core = execa('node', ['--import', 'tsx', 'src/index.ts'], {
  cwd: CORE_DIR,
  reject: false,
  env: {
    ...process.env,
    K_DATA_DIR: dataDir,
    PORT: String(PORT),
    HARNESS_TOKEN: TOKEN,
    ENABLE_GITHUB_POLL: 'false',
    CHIEF_WAKE: '0',
    LEAD_DISPATCH_RELAY: '0',
    GRAPH_AUTO_REINDEX: '0',
  },
})
core.stdout!.on('data', (c: Buffer) => process.stdout.write(`[core] ${c}`))
core.stderr!.on('data', (c: Buffer) => process.stdout.write(`[core!] ${c}`))

async function cleanup(): Promise<void> {
  try { core.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([core, new Promise(r => setTimeout(r, 5000))])
  try { core.kill('SIGKILL') } catch { /* gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  await cleanup()
  console.error('SMOKE FAIL: core did not become healthy within 60s')
  process.exit(1)
}

await waitForHealth()

// WS capture — canonical triples ride run_update; checkpoint events ride 'event'.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
const wsRunUpdates: Array<Record<string, unknown>> = []
const wsCheckpointEvents: Array<Record<string, unknown>> = []
ws.on('message', (data: Buffer) => {
  try {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>
    if (msg.type === 'run_update') wsRunUpdates.push(msg.run as Record<string, unknown>)
    if (msg.type === 'event' && (msg.event as Record<string, unknown>)?.type === 'checkpoint') {
      wsCheckpointEvents.push(msg.event as Record<string, unknown>)
    }
  } catch { /* ignore */ }
})
await new Promise<void>((resolve, reject) => {
  ws.on('open', () => resolve())
  ws.on('error', e => reject(e))
})

// Dispatch ONE cheap run that performs a real tool wave (a Write) so a
// checkpoint boundary fires. Default cwd = the K repo root -> detached worktree.
const startRes = await fetch(`${BASE}/api/runs`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Create a file named k-smoke-p0.txt containing the single line SMOKE-OK. Then reply done. Do nothing else.',
    model: MODEL,
  }),
})
if (startRes.status !== 201) {
  console.error(`SMOKE FAIL: POST /api/runs -> ${startRes.status}: ${await startRes.text()}`)
  await cleanup()
  process.exit(1)
}
const run = (await startRes.json()) as { id: string }
console.log(`\n[smoke] run started: ${run.id}`)

// Poll to terminal (10 min hard bound, then kill).
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])
let finalRun: Record<string, unknown> | null = null
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const res = await fetch(`${BASE}/api/runs/${run.id}`, { headers: AUTH })
  const body = (await res.json()) as Record<string, unknown>
  if (TERMINAL.has(String(body.status))) { finalRun = body; break }
}
if (!finalRun) {
  await fetch(`${BASE}/api/runs/${run.id}/kill`, { method: 'POST', headers: AUTH })
  console.error('SMOKE FAIL: run did not reach a terminal status within 10 minutes (killed)')
  await cleanup()
  process.exit(1)
}
console.log(`[smoke] run terminal: ${String(finalRun.status)}`)

const problems: string[] = []

// (1) cli_session_id stored + surfaced.
if (typeof finalRun.cliSessionId !== 'string' || finalRun.cliSessionId.length === 0) {
  problems.push('runs.cli_session_id NOT captured (GET /api/runs/:id cliSessionId missing)')
} else {
  console.log(`[smoke] OK cliSessionId = ${finalRun.cliSessionId}`)
}

// (2) checkpoint: event on the wire + ref in the repo (refs outlive the worktree).
const refOut = (
  await execa('git', ['-C', REPO_ROOT, 'for-each-ref', `refs/k-checkpoints/${run.id}`], { reject: false })
).stdout.trim()
if (wsCheckpointEvents.length === 0) problems.push('no checkpoint event observed on the WS wire')
else console.log(`[smoke] OK ${wsCheckpointEvents.length} checkpoint event(s) on the wire`)
if (refOut === '') problems.push(`refs/k-checkpoints/${run.id} not found in the repo`)
else console.log(`[smoke] OK checkpoint ref: ${refOut}`)

// (3) canonical triples on the WS wire — on EVERY run_update for this run.
const mine = wsRunUpdates.filter(r => r.id === run.id)
const withCanonical = mine.filter(r => {
  const c = r.canonical as Record<string, unknown> | undefined
  return c != null && typeof c.state === 'string' && typeof c.attention === 'string' && typeof c.health === 'string'
})
if (mine.length === 0) problems.push('no run_update messages observed on the WS wire')
else if (withCanonical.length !== mine.length) {
  problems.push(`only ${withCanonical.length}/${mine.length} run_update messages carried a canonical triple`)
} else {
  const states = [...new Set(withCanonical.map(r => (r.canonical as Record<string, unknown>).state))]
  console.log(`[smoke] OK canonical on all ${withCanonical.length} run_update(s); states seen: ${states.join(', ')}`)
}

console.log(`[smoke] MEASURED COST: $${Number(finalRun.costUsd ?? 0).toFixed(4)} — log this in tasks/todo.md (measured, never estimated)`)

// Delete the smoke's checkpoint ref — a smoke artifact, not product state.
if (refOut !== '') {
  await execa('git', ['-C', REPO_ROOT, 'update-ref', '-d', `refs/k-checkpoints/${run.id}`], { reject: false })
  console.log('[smoke] checkpoint ref deleted (smoke artifact)')
}

ws.close()
await cleanup()

if (problems.length > 0) {
  console.error('\nSMOKE FAIL:')
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — checkpoints + cli_session_id + canonical WS statuses all verified.')
