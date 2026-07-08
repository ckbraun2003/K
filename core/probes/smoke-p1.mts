/**
 * P1 PHASE SMOKE (Trust Core) — the review→fix→verify→rewind loop through the
 * REAL core, against a THROWAWAY scratch repo (never the K repo, never the dev
 * core's data dir):
 *   1. original run (haiku) creates hello.js + README line   → diff: hello.js ADDED
 *   2. review comment on hello.js:1                          → request-changes
 *   3. fix run starts FROM the reviewed final checkpoint     → diff: hello.js MODIFIED
 *      (baseRef === original headRef), comments flip to 'sent', prompt carries the body
 *   4. verify engine runs the project recipe on the fix run  → status 'pass', scope.files ≠ []
 *   5. rewind from wave-1 → new run renames hello.js→greet.js → diff baseRef === wave-1 sha
 *
 * Boots an ISOLATED core (fresh K_DATA_DIR, port 3215, pollers off). Every
 * dispatch pins model claude-haiku-4-5-20251001. Costs are MEASURED (run.costUsd,
 * CLI-reported — never estimated); hard abort if accumulated cost would exceed $10.
 *
 * PRECONDITION (P0 lesson): the K repo's .worktrees/ and refs/k-checkpoints/*
 * must be empty OR every other core stopped — this core's boot sweeps both
 * against ITS OWN (empty) DB. Checked manually before each invocation.
 * LIVE (haiku ×3 — expected well under $1 measured). NEVER runs in CI.
 * Run from core/:  pnpm exec tsx probes/smoke-p1.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORE_DIR = path.join(__dirname, '..')       // core/
const REPO_ROOT = path.join(__dirname, '../..')   // k/
const OUT_DIR = path.join(__dirname, 'out', 'p1')
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tasks', 'p1-evidence')
const PORT = 3215
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const MODEL = 'claude-haiku-4-5-20251001'
const COST_CAP_USD = 10
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])
const VERIFY_TERMINAL = new Set(['pass', 'fail', 'skipped', 'error'])

fs.mkdirSync(OUT_DIR, { recursive: true })

// ── result accounting ─────────────────────────────────────────────────────────
type RunRecord = {
  role: 'original' | 'fix' | 'rewind'
  id: string
  status: string
  costUsd: number
  cliSessionId?: string
}
const result: {
  startedAt: string
  finishedAt: string | null
  model: string
  runs: RunRecord[]
  totalCostUsd: number
  assertions: Record<string, 'pass' | 'fail'>
  info: Record<string, unknown>
  evidence: Record<string, unknown>
} = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  model: MODEL,
  runs: [],
  totalCostUsd: 0,
  assertions: {},
  info: {},
  evidence: {},
}

function assert(name: string, ok: boolean, detail?: unknown): boolean {
  result.assertions[name] = ok ? 'pass' : 'fail'
  console.log(`[smoke] ${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok && detail !== undefined) result.evidence[name] = detail
  return ok
}

// ── scratch repo (throwaway; deleted at the end) ──────────────────────────────
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p1-scratch-'))
const GIT_ID = ['-c', 'user.name=p1-smoke', '-c', 'user.email=p1-smoke@k.local']
await execa('git', ['-C', scratchDir, 'init', '-b', 'main'], { reject: true })
fs.writeFileSync(path.join(scratchDir, 'README.md'), '# p1 smoke scratch\n')
await execa('git', ['-C', scratchDir, ...GIT_ID, 'add', '-A'], { reject: true })
await execa('git', ['-C', scratchDir, ...GIT_ID, 'commit', '-m', 'seed'], { reject: true })
console.log(`[smoke] scratch repo: ${scratchDir}`)

// ── isolated core boot (fresh data dir, spare port, pollers off) ──────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p1-smoke-'))
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

const myRunIds: string[] = []

async function cleanup(): Promise<void> {
  // Windows: taskkill the WHOLE tree (core may hold node/git children); POSIX: TERM→KILL.
  if (core.pid && process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(core.pid), '/T', '/F'], { reject: false })
  } else {
    try { core.kill('SIGTERM') } catch { /* gone */ }
  }
  await Promise.race([core, new Promise(r => setTimeout(r, 5000))])
  try { core.kill('SIGKILL') } catch { /* gone */ }
  // Verify the port is actually free again (up to 10s).
  let portFree = false
  for (let i = 0; i < 10; i++) {
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
    } catch { portFree = true; break }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.log(`[smoke] port ${PORT} free after shutdown: ${portFree}`)
  // Targeted worktree-leftover sweep: ONLY this probe's run ids, never others'.
  for (const id of myRunIds) {
    const wt = path.join(REPO_ROOT, '.worktrees', id)
    if (fs.existsSync(wt)) {
      await execa('git', ['-C', scratchDir, 'worktree', 'remove', '--force', wt], { reject: false })
      try { fs.rmSync(wt, { recursive: true, force: true }) } catch { /* best-effort */ }
      console.log(`[smoke] removed leftover worktree ${wt}`)
    }
  }
  // Throwaway dirs (retry: SQLite/git handles can lag a moment on Windows).
  for (const dir of [scratchDir, dataDir]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break } catch { await new Promise(r => setTimeout(r, 2000)) }
    }
    console.log(`[smoke] removed ${dir}: ${!fs.existsSync(dir)}`)
  }
}

async function fail(msg: string): Promise<never> {
  console.error(`\nSMOKE FAIL: ${msg}`)
  result.info.failure = msg
  finishResult()
  await cleanup()
  process.exit(1)
}

function finishResult(): void {
  result.finishedAt = new Date().toISOString()
  result.totalCostUsd = result.runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  const json = JSON.stringify(result, null, 2)
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-result.json'), json)
  // Copy evidence OUT before any cleanup (tasks/ is gitignored — tree stays clean).
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'smoke-result.json'), json)
}

// ── tiny API client ───────────────────────────────────────────────────────────
async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let parsed: any = null
  try { parsed = await res.json() } catch { /* non-JSON (204 etc.) */ }
  return { status: res.status, body: parsed }
}

async function pollRunDone(id: string, label: string): Promise<any> {
  for (let i = 0; i < 120; i++) { // 10 min bound
    await new Promise(r => setTimeout(r, 5000))
    const { body } = await api('GET', `/api/runs/${id}`)
    if (body && TERMINAL.has(String(body.status))) return body
  }
  await api('POST', `/api/runs/${id}/kill`)
  return fail(`${label} run ${id} did not reach a terminal status within 10 minutes (killed)`)
}

/** Record a terminal run + enforce the hard measured-cost cap. */
async function recordRun(role: RunRecord['role'], run: any): Promise<void> {
  result.runs.push({
    role, id: String(run.id), status: String(run.status),
    costUsd: Number(run.costUsd ?? 0), cliSessionId: run.cliSessionId,
  })
  const total = result.runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  console.log(`[smoke] ${role} run ${run.id}: ${run.status}, MEASURED $${Number(run.costUsd ?? 0).toFixed(4)} (total $${total.toFixed(4)})`)
  if (total > COST_CAP_USD) await fail(`accumulated MEASURED cost $${total.toFixed(4)} exceeds the hard $${COST_CAP_USD} cap — aborting`)
  // Transcript: the run's full event log (raw CLI lines included).
  const ev = await api('GET', `/api/runs/${run.id}/events?raw=1`)
  fs.writeFileSync(path.join(OUT_DIR, `${role}-${run.id}.events.json`), JSON.stringify(ev.body, null, 2))
}

// ── boot ──────────────────────────────────────────────────────────────────────
{
  let healthy = false
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { healthy = true; break } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!healthy) await fail('core did not become healthy within 60s')
}

// ── step 1: register scratch project + verify recipe ──────────────────────────
const reg = await api('POST', '/api/projects', { name: 'p1-smoke-scratch', localPath: scratchDir })
if (reg.status !== 201) await fail(`project registration -> ${reg.status}: ${JSON.stringify(reg.body)}`)
const project = reg.body
const recipe = { commands: [{ label: 'node-check', run: 'node -e "require(\'fs\').accessSync(\'hello.js\')"' }] }
const patch = await api('PATCH', `/api/projects/${project.id}/verify-recipe`, { recipe })
if (patch.status !== 200) await fail(`verify-recipe PATCH -> ${patch.status}: ${JSON.stringify(patch.body)}`)
console.log(`[smoke] project registered ${project.id}, verify recipe set`)

// ── step 2: original run (haiku, pinned) ──────────────────────────────────────
const start = await api('POST', '/api/runs', {
  prompt: "Create hello.js that prints 'hello from k' and a README line documenting it",
  cwd: project.localPath,
  projectId: project.id,
  model: MODEL,
})
if (start.status !== 201) await fail(`POST /api/runs -> ${start.status}: ${JSON.stringify(start.body)}`)
const origId = String(start.body.id)
myRunIds.push(origId)
console.log(`[smoke] original run started: ${origId}`)
const orig = await pollRunDone(origId, 'original')
await recordRun('original', orig)
assert('original_run_done', orig.status === 'done', { status: orig.status })

// ── step 3: review diff — hello.js ADDED via the checkpoint chain ─────────────
const origDiff = await api('GET', `/api/runs/${origId}/diff`)
result.evidence.originalDiff = {
  status: origDiff.status, baseRef: origDiff.body?.baseRef, headRef: origDiff.body?.headRef,
  files: origDiff.body?.files?.map((f: any) => ({ path: f.path, status: f.status, oldPath: f.oldPath })),
}
const helloAdded = origDiff.body?.files?.find((f: any) => f.path === 'hello.js')
assert('original_diff_hello_added', origDiff.status === 200 && helloAdded?.status === 'added', result.evidence.originalDiff)

// ── step 4: comment ───────────────────────────────────────────────────────────
const COMMENT_BODY = 'Also print the current year'
const comment = await api('POST', `/api/runs/${origId}/comments`, { file: 'hello.js', line: 1, body: COMMENT_BODY })
assert('comment_created', comment.status === 201 && comment.body?.status === 'draft', { status: comment.status, body: comment.body })

// ── step 5: request changes → fix run (haiku, pinned) ─────────────────────────
const rc = await api('POST', `/api/runs/${origId}/request-changes`, { model: MODEL })
if (rc.status !== 201) await fail(`request-changes -> ${rc.status}: ${JSON.stringify(rc.body)}`)
assert('request_changes_201', true, { commentsSent: rc.body.commentsSent })
const fixId = String(rc.body.run.id)
myRunIds.push(fixId)
assert('fix_prompt_contains_comment', String(rc.body.run.prompt).includes(COMMENT_BODY))
console.log(`[smoke] fix run started: ${fixId}`)

const sentComments = await api('GET', `/api/runs/${origId}/comments`)
result.evidence.commentsAfterRequestChanges = sentComments.body
assert('original_comments_sent',
  Array.isArray(sentComments.body) && sentComments.body.length > 0 && sentComments.body.every((c: any) => c.status === 'sent'))

const fix = await pollRunDone(fixId, 'fix')
await recordRun('fix', fix)
assert('fix_run_done', fix.status === 'done', { status: fix.status })

// Fix diff: hello.js MODIFIED (not re-created) + base === original head (tree carried).
const fixDiff = await api('GET', `/api/runs/${fixId}/diff`)
result.evidence.fixDiff = {
  status: fixDiff.status, baseRef: fixDiff.body?.baseRef, headRef: fixDiff.body?.headRef,
  files: fixDiff.body?.files?.map((f: any) => ({ path: f.path, status: f.status, oldPath: f.oldPath })),
}
const helloFixed = fixDiff.body?.files?.find((f: any) => f.path === 'hello.js')
assert('fix_diff_hello_modified', helloFixed?.status === 'modified', result.evidence.fixDiff)
assert('fix_diff_base_is_original_head',
  fixDiff.body?.baseRef != null && fixDiff.body.baseRef === origDiff.body?.headRef,
  { fixBase: fixDiff.body?.baseRef, originalHead: origDiff.body?.headRef })

// ── step 6: verified badge — fix run's verify-result reaches 'pass' ───────────
async function pollVerify(id: string, cycles: number): Promise<any> {
  for (let i = 0; i < cycles; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const res = await api('GET', `/api/runs/${id}/verify-result`)
    if (res.status === 200 && VERIFY_TERMINAL.has(String(res.body?.status))) return res.body
  }
  return null
}
let fixVerify = await pollVerify(fixId, 36) // 3 min
if (!fixVerify) fixVerify = await pollVerify(fixId, 12) // ONE re-poll cycle (failure rule)
result.evidence.fixVerify = fixVerify
assert('fix_verify_pass', fixVerify?.status === 'pass', fixVerify ?? 'verify-result never reached a terminal status')
assert('fix_verify_scope_files_nonempty', Array.isArray(fixVerify?.scope?.files) && fixVerify.scope.files.length > 0,
  fixVerify?.scope)

// ── step 7: rewind from wave 1 (haiku, pinned) ────────────────────────────────
const ckpts = await api('GET', `/api/runs/${origId}/checkpoints`)
result.evidence.originalCheckpoints = ckpts.body
const wave1 = Array.isArray(ckpts.body) ? ckpts.body.find((c: any) => c.wave === 1) : undefined
assert('checkpoints_wave1_present', wave1 !== undefined, ckpts.body)
if (!wave1) await fail('no wave-1 checkpoint on the original run — cannot rewind')

const rw = await api('POST', `/api/runs/${origId}/rewind`, {
  sha: wave1.sha,
  prompt: 'Rename hello.js to greet.js keeping behavior',
  model: MODEL,
})
if (rw.status !== 201) await fail(`rewind -> ${rw.status}: ${JSON.stringify(rw.body)}`)
const rewindId = String(rw.body.id)
myRunIds.push(rewindId)
console.log(`[smoke] rewind run started: ${rewindId} (from wave-1 ${wave1.sha.slice(0, 8)})`)
const rewound = await pollRunDone(rewindId, 'rewind')
await recordRun('rewind', rewound)
assert('rewind_run_done', rewound.status === 'done', { status: rewound.status })

// Rewound diff: base lineage = the wave-1 state (its first checkpoint's parent
// is the worktree HEAD, which IS the wave-1 sha), and the files reflect the rename.
const rwDiff = await api('GET', `/api/runs/${rewindId}/diff`)
result.evidence.rewindDiff = {
  status: rwDiff.status, baseRef: rwDiff.body?.baseRef, headRef: rwDiff.body?.headRef,
  files: rwDiff.body?.files?.map((f: any) => ({ path: f.path, status: f.status, oldPath: f.oldPath })),
}
assert('rewind_diff_base_is_wave1_sha', rwDiff.body?.baseRef === wave1.sha,
  { rewindBase: rwDiff.body?.baseRef, wave1Sha: wave1.sha })
const greet = rwDiff.body?.files?.find((f: any) => f.path === 'greet.js')
assert('rewind_diff_reflects_rename', greet !== undefined && (greet.status === 'renamed' || greet.status === 'added'),
  result.evidence.rewindDiff)

// Informational (not asserted): the rewind run's verify is EXPECTED to fail —
// its recipe checks hello.js, which the rewind deliberately renamed away. Wait
// for it so the verify worktree is settled before we tear the stack down.
result.info.rewindVerify = (await pollVerify(rewindId, 24)) ?? 'did not reach terminal before shutdown'

// ── step 8: budget + wrap-up ──────────────────────────────────────────────────
const total = result.runs.reduce((s, r) => s + (r.costUsd || 0), 0)
assert('budget_under_cap', total <= COST_CAP_USD, { totalCostUsd: total, capUsd: COST_CAP_USD })
result.info.approvePrLeg =
  'E-01 approve->PR live leg NOT exercised here (no scratch remote): POST /api/runs/:id/approve rides the EXISTING createPR path, live-proven in the KAT campaign.'
console.log(`[smoke] TOTAL MEASURED COST: $${total.toFixed(4)} (cap $${COST_CAP_USD})`)

finishResult()
// Copy the fix run's transcript alongside the result as the key evidence transcript.
{
  const t = path.join(OUT_DIR, `fix-${fixId}.events.json`)
  if (fs.existsSync(t)) fs.copyFileSync(t, path.join(EVIDENCE_DIR, `fix-${fixId}.events.json`))
}
await cleanup()

const failed = Object.entries(result.assertions).filter(([, v]) => v === 'fail')
if (failed.length > 0) {
  console.error(`\nSMOKE FAIL — ${failed.length} assertion(s) failed: ${failed.map(([k]) => k).join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — review diff, request-changes fix (tree carried), comments sent, verify badge, and rewind lineage all verified with measured costs.')
