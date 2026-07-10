/**
 * P3 PHASE SMOKE (Visibility) — E-09 Org Timeline feed, E-08 Run Narrative, and
 * E-13 measured cost lens (recent-actuals + cost-rollup) driven through the REAL
 * core against an ISOLATED stack (never the dev data/k.db, never the host ~/.claude).
 *
 * The cost legs are REAL dispatches (measured cost_usd only, never estimated):
 *   • 6 tiny HAIKU runs ("reply with the single word: ready") under ONE registered
 *     project, each tracked by a seeded `agent_runs` row (trigger 'user-message',
 *     status 'completed') that attributes the run to a SINGLE real seeded profile —
 *     the exact tracking row startAgentRun writes (agent_runs is what recent-actuals
 *     reads). Org loops are OFF in this isolated core, so the attribution row is
 *     seeded directly, mirroring smoke-p2's lesson/mcp DB seeding. The RUNS are real;
 *     only the profile-attribution row is seeded.
 *
 * Assertions against the resulting REAL data:
 *   E-09 feed: GET /api/feed (default + ?limit=500) include the 6 fresh runs; total
 *     === Σcounts; ?kinds=done narrows; repeated ?kinds=done&kinds=failure (array
 *     form) does NOT 500.
 *   E-08 narrative: GET /api/runs/:id/narrative returns the deterministic fields
 *     (goal/outcome/files/verification/cost) with cost.costUsd == the run's measured
 *     cost_usd; because Ollama is NOT running the bullets take the GRACEFUL-DEGRADE
 *     path (bullets:null, bulletsState 'unavailable'|'disabled', prompt return). The
 *     populated-bullets path is covered by Lane A's injected-transport UNIT test
 *     (core/test) — this smoke asserts only the degrade path.
 *   E-13 cost lens: recent-actuals?profileId=<the dispatched profile> => scope
 *     'profile' (n>=5, PRIMARY path, not a fallback), median/p90 finite + consistent
 *     with the observed costs; a bogus/thin profile FALLS BACK (project|global).
 *     cost-rollup?groupBy=project (and day) buckets sum to the measured total. No
 *     price*token math anywhere — the responses are measured actuals.
 *   Grep gate: the committed core/test/no-price-tables.test.ts runs GREEN (1/1).
 *
 * Boots an ISOLATED core (fresh K_DATA_DIR, spare port 3217, pollers off). Every
 * dispatch pins model claude-haiku-4-5-20251001. Costs are MEASURED (run.costUsd,
 * CLI-reported — never estimated); hard abort if accumulated cost exceeds $2.
 * LIVE (haiku ×6 — expected well under $1 measured). NEVER runs in CI.
 * Run from core/:  pnpm exec tsx probes/smoke-p3.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// better-sqlite3 resolves from core/node_modules (this file lives in core/probes).
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORE_DIR = path.join(__dirname, '..')       // core/
const REPO_ROOT = path.join(__dirname, '../..')   // k/
const OUT_DIR = path.join(__dirname, 'out', 'p3') // GITIGNORED (core/probes/out/)
const PORT = 3217                                  // spare (P1 3215, P2 3216) — NEVER 3001
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const MODEL = 'claude-haiku-4-5-20251001'
const COST_CAP_USD = 2                             // hard safety abort (ceiling; expected << $1)
const DISPATCH_COUNT = 6
const RUN_PROMPT = 'reply with the single word: ready'
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])

fs.mkdirSync(OUT_DIR, { recursive: true })

// ── result accounting ─────────────────────────────────────────────────────────
type RunRecord = { id: string; status: string; costUsd: number; tokensIn: number; tokensOut: number }
const assertions: { name: string; ok: boolean; detail?: unknown }[] = []
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  model: MODEL,
  port: PORT,
  profileId: null as string | null,
  profileName: null as string | null,
  runs: [] as RunRecord[],
  totalCostUsd: 0,
  budgetCapUsd: COST_CAP_USD,
  budgetExceeded: false,
  assertions,
  ollama: {} as Record<string, unknown>,
  feed: {} as Record<string, unknown>,
  narrative: {} as Record<string, unknown>,
  recentActuals: {} as Record<string, unknown>,
  costRollup: {} as Record<string, unknown>,
  grepGate: {} as Record<string, unknown>,
  info: {} as Record<string, unknown>,
}
const runs = result.runs as RunRecord[]

function assert(name: string, ok: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, detail })
  console.log(`[smoke] ${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  return ok
}

/** R-7 / numpy-default percentile (linear interpolation) — mirrors core/src/metrics.ts:percentile
 *  so the probe's EXPECTED median/p90 use the same math the route uses. `sorted` ascending, p∈[0,1]. */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0]
  const rank = p * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

// ── isolated data dir + throwaway local scratch repo ──────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p3-data-'))
const dbFile = path.join(dataDir, 'k.db')
const GIT_ID = ['-c', 'user.name=p3-smoke', '-c', 'user.email=p3-smoke@k.local']

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p3-scratch-'))
await execa('git', ['-C', scratchDir, 'init', '-b', 'main'], { reject: true })
fs.writeFileSync(path.join(scratchDir, 'README.md'), '# p3 smoke scratch\n')
await execa('git', ['-C', scratchDir, ...GIT_ID, 'add', '-A'], { reject: true })
await execa('git', ['-C', scratchDir, ...GIT_ID, 'commit', '-m', 'seed'], { reject: true })
console.log(`[smoke] scratch repo: ${scratchDir}`)
console.log(`[smoke] isolated data dir: ${dataDir}`)

const myRunIds: string[] = []

// ── isolated core boot (fresh data dir, spare port, pollers off) ──────────────
type Core = ReturnType<typeof execa>
function spawnCore(): Core {
  const c = execa('node', ['--import', 'tsx', 'src/index.ts'], {
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
  c.stdout!.on('data', (b: Buffer) => process.stdout.write(`[core] ${b}`))
  c.stderr!.on('data', (b: Buffer) => process.stdout.write(`[core!] ${b}`))
  return c
}

let core: Core = spawnCore()

async function killCore(c: Core): Promise<void> {
  if (c.pid && process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(c.pid), '/T', '/F'], { reject: false })
  } else {
    try { c.kill('SIGTERM') } catch { /* gone */ }
  }
  await Promise.race([c, new Promise(r => setTimeout(r, 5000))])
  try { c.kill('SIGKILL') } catch { /* gone */ }
}

async function waitHealthy(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function cleanup(): Promise<void> {
  await killCore(core)
  // Verify the port is free again (up to 10s).
  let portFree = false
  for (let i = 0; i < 10; i++) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }) }
    catch { portFree = true; break }
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
  await execa('git', ['-C', REPO_ROOT, 'worktree', 'prune'], { reject: false })
  // Throwaway dirs (retry: SQLite/git handles can lag on Windows).
  for (const dir of [scratchDir, dataDir]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break } catch { await new Promise(r => setTimeout(r, 2000)) }
    }
    console.log(`[smoke] removed ${dir}: ${!fs.existsSync(dir)}`)
  }
}

function finishResult(): void {
  result.finishedAt = new Date().toISOString()
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  result.totalCostUsd = total
  result.budgetExceeded = total > COST_CAP_USD
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-result.json'), JSON.stringify(result, null, 2))
}

async function fail(msg: string): Promise<never> {
  console.error(`\nSMOKE FAIL: ${msg}`)
  result.info = { ...(result.info as object), failure: msg }
  finishResult()
  await cleanup()
  process.exit(1)
}

// ── tiny API client ───────────────────────────────────────────────────────────
async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let parsed: any = null
  try { parsed = await res.json() } catch { /* 204 / non-JSON */ }
  return { status: res.status, body: parsed }
}

async function pollRunDone(id: string, label: string, tries = 120): Promise<any> {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const { body } = await api('GET', `/api/runs/${id}`)
    if (body && TERMINAL.has(String(body.status))) return body
  }
  await api('POST', `/api/runs/${id}/kill`)
  return fail(`${label} run ${id} did not reach a terminal status within ${tries * 5}s (killed)`)
}

async function recordRun(run: any): Promise<void> {
  const rec: RunRecord = {
    id: String(run.id), status: String(run.status),
    costUsd: Number(run.costUsd ?? 0), tokensIn: Number(run.tokensIn ?? 0), tokensOut: Number(run.tokensOut ?? 0),
  }
  runs.push(rec)
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  console.log(`[smoke] run ${run.id}: ${run.status}, MEASURED $${rec.costUsd.toFixed(4)} (total $${total.toFixed(4)})`)
  if (total > COST_CAP_USD) await fail(`accumulated MEASURED cost $${total.toFixed(4)} exceeds the hard $${COST_CAP_USD} cap — aborting`)
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
if (!(await waitHealthy(60))) await fail('core did not become healthy within 60s')

// Pick a SINGLE real seeded profile to attribute all 6 dispatches to (the FK target
// for the seeded agent_runs rows, and the profileId recent-actuals reads). K/Chief/leads
// are seeded at boot — take the first one deterministically.
const profilesRes = await api('GET', '/api/profiles')
const profiles = Array.isArray(profilesRes.body) ? profilesRes.body : []
if (profiles.length === 0) await fail(`GET /api/profiles returned no seeded profiles (status ${profilesRes.status})`)
const profile = profiles[0]
const PROFILE_ID = String(profile.id)
result.profileId = PROFILE_ID
result.profileName = profile.name != null ? String(profile.name) : null
console.log(`[smoke] attributing dispatches to profile ${PROFILE_ID} (${result.profileName})`)

// Register the scratch project (local; no remote derived).
const reg = await api('POST', '/api/projects', { name: 'p3-smoke-scratch', localPath: scratchDir })
if (reg.status !== 201) await fail(`project registration -> ${reg.status}: ${JSON.stringify(reg.body)}`)
const project = reg.body
const PROJECT_ID = String(project.id)
console.log(`[smoke] project registered ${PROJECT_ID}`)

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 1 — REAL dispatch chain (MEASURED, cheap): 6 haiku runs under one profile
// ══════════════════════════════════════════════════════════════════════════════
for (let i = 0; i < DISPATCH_COUNT; i++) {
  const start = await api('POST', '/api/runs', {
    prompt: RUN_PROMPT, cwd: scratchDir, projectId: PROJECT_ID, model: MODEL,
  })
  if (start.status !== 201) await fail(`dispatch #${i + 1} -> ${start.status}: ${JSON.stringify(start.body)}`)
  const runId = String(start.body.id)
  myRunIds.push(runId)
  console.log(`[smoke] dispatch #${i + 1} started: ${runId}`)
  const done = await pollRunDone(runId, `dispatch-${i + 1}`)
  await recordRun(done)
  // Seed the agent_runs attribution row — the SAME tracking row startAgentRun writes
  // (org loops are off in this isolated core). The run itself is REAL; only the
  // profile attribution is seeded. recent-actuals reads EXISTS(run_id, profile_id).
  const seed = new Database(dbFile)
  seed.pragma('busy_timeout = 8000')
  seed.pragma('foreign_keys = ON')
  const now = Date.now()
  seed.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, project_id, workflow_id, status, created_at, completed_at)
                VALUES (?, ?, ?, 'user-message', ?, ?, NULL, 'completed', ?, ?)`)
    .run(randomUUID(), PROFILE_ID, runId, RUN_PROMPT, PROJECT_ID, now, now)
  seed.close()
}
const measuredTotal = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
const positiveCosts = runs.map(r => r.costUsd).filter(c => c > 0).sort((a, b) => a - b)
assert('p3_1_six_real_dispatches_done', runs.length === DISPATCH_COUNT && runs.every(r => r.status === 'done'),
  { dispatched: runs.length, statuses: runs.map(r => r.status) })
assert('p3_1_measured_cost_under_cap', measuredTotal > 0 && measuredTotal < COST_CAP_USD,
  { measuredTotal: Number(measuredTotal.toFixed(6)), cap: COST_CAP_USD })
assert('p3_1_at_least_5_positive_cost', positiveCosts.length >= 5,
  { positiveCount: positiveCosts.length, costs: positiveCosts.map(c => Number(c.toFixed(6))) })
console.log(`[smoke] MEASURED total $${measuredTotal.toFixed(4)} across ${runs.length} dispatches; positive-cost pool n=${positiveCosts.length}`)

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 2 — E-09 feed reflects the real dispatches
// ══════════════════════════════════════════════════════════════════════════════
const feedDefault = await api('GET', '/api/feed')
if (feedDefault.status !== 200) await fail(`GET /api/feed -> ${feedDefault.status}`)
const fdItems: any[] = feedDefault.body?.items ?? []
const fdCounts: Record<string, number> = feedDefault.body?.counts ?? {}
const fdTotal = Number(feedDefault.body?.total)
const fdSumCounts = Object.values(fdCounts).reduce((s, n) => s + Number(n), 0)
const fdRunIds = new Set(fdItems.map(i => i.runId).filter(Boolean))
const freshInDefault = myRunIds.filter(id => fdRunIds.has(id)).length
result.feed = { ...(result.feed as object), defaultItems: fdItems.length, total: fdTotal, sumCounts: fdSumCounts, counts: fdCounts, freshInDefault }
assert('p3_2_feed_default_contains_6_runs', freshInDefault >= DISPATCH_COUNT,
  { freshInDefault, expected: DISPATCH_COUNT })
assert('p3_2_feed_total_eq_sum_counts', fdTotal === fdSumCounts,
  { total: fdTotal, sumCounts: fdSumCounts })
// Each done run projects a 'done' head — at least our 6.
assert('p3_2_feed_done_kind_ge_6', Number(fdCounts.done ?? 0) >= DISPATCH_COUNT,
  { doneCount: fdCounts.done })

const feedLarge = await api('GET', '/api/feed?limit=500')
if (feedLarge.status !== 200) await fail(`GET /api/feed?limit=500 -> ${feedLarge.status}`)
const flRunIds = new Set((feedLarge.body?.items ?? []).map((i: any) => i.runId).filter(Boolean))
const freshInLarge = myRunIds.filter(id => flRunIds.has(id)).length
assert('p3_2_feed_limit500_contains_6_runs', freshInLarge >= DISPATCH_COUNT,
  { freshInLarge, items: feedLarge.body?.items?.length })

// ?kinds=done narrows correctly (every item is 'done'; total == counts.done).
const feedDone = await api('GET', '/api/feed?kinds=done')
if (feedDone.status !== 200) await fail(`GET /api/feed?kinds=done -> ${feedDone.status}`)
const fdoItems: any[] = feedDone.body?.items ?? []
const allDone = fdoItems.length > 0 && fdoItems.every(i => i.kind === 'done')
const doneNarrowConsistent = Number(feedDone.body?.total) === Number(feedDone.body?.counts?.done ?? 0)
  && Object.entries(feedDone.body?.counts ?? {}).every(([k, v]) => k === 'done' || Number(v) === 0)
result.feed = { ...(result.feed as object), kindsDoneTotal: feedDone.body?.total, kindsDoneCounts: feedDone.body?.counts }
assert('p3_2_feed_kinds_done_narrows', allDone && doneNarrowConsistent,
  { items: fdoItems.length, allDone, doneNarrowConsistent, total: feedDone.body?.total })

// Repeated ?kinds=done&kinds=failure (array form) must NOT 500.
const feedArray = await api('GET', '/api/feed?kinds=done&kinds=failure')
result.feed = { ...(result.feed as object), arrayFormStatus: feedArray.status }
assert('p3_2_feed_kinds_array_no_500', feedArray.status === 200,
  { status: feedArray.status })

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 3 — E-08 narrative for a real run (deterministic + graceful degrade)
// ══════════════════════════════════════════════════════════════════════════════
const narrRun = runs.find(r => r.status === 'done')!
const t0 = Date.now()
const narr = await api('GET', `/api/runs/${narrRun.id}/narrative`)
const narrMs = Date.now() - t0
if (narr.status !== 200) await fail(`GET /api/runs/:id/narrative -> ${narr.status}`)
const n = narr.body
const detOk = n.runId === narrRun.id
  && typeof n.goal === 'string' && n.goal.length > 0
  && n.outcome?.status === 'done'
  && Array.isArray(n.files)
  && ('verification' in n)                 // deterministic field present (null when no verify)
  && n.cost && typeof n.cost.costUsd === 'number'
const costMatches = Math.abs(Number(n.cost?.costUsd) - narrRun.costUsd) < 1e-9
const degradeOk = n.bullets == null
  && (n.bulletsState === 'unavailable' || n.bulletsState === 'disabled')
const promptOk = narrMs < 5000            // degrade returns before the 20s bullet timer
result.ollama = { reachable: false, bulletsState: n.bulletsState, note: 'Ollama not running — bullets took the graceful-degrade path' }
result.narrative = {
  runId: n.runId, goal: n.goal, outcome: n.outcome, files: n.files, verification: n.verification,
  cost: n.cost, bullets: n.bullets, bulletsState: n.bulletsState, elapsedMs: narrMs,
}
assert('p3_3_narrative_deterministic_fields', detOk,
  { runId: n.runId, goal: n.goal, status: n.outcome?.status, files: n.files, verification: n.verification, cost: n.cost })
assert('p3_3_narrative_cost_matches_measured', costMatches,
  { narrativeCost: n.cost?.costUsd, runCost: narrRun.costUsd })
assert('p3_3_narrative_bullets_degrade', degradeOk && promptOk,
  { bullets: n.bullets, bulletsState: n.bulletsState, elapsedMs: narrMs, promptReturn: promptOk })

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 4 — E-13 measured cost lens (recent-actuals + cost-rollup)
// ══════════════════════════════════════════════════════════════════════════════
// Primary path: recent-actuals scoped to the dispatched profile (n>=5 => scope 'profile').
const ra = await api('GET', `/api/metrics/recent-actuals?profileId=${encodeURIComponent(PROFILE_ID)}`)
if (ra.status !== 200) await fail(`GET recent-actuals (profile) -> ${ra.status}`)
const raBody = ra.body
const expMedian = percentile(positiveCosts, 0.5)
const expP90 = percentile(positiveCosts, 0.9)
const medianFinite = Number.isFinite(raBody.medianCostUsd) && Number.isFinite(raBody.p90CostUsd)
const medianConsistent = Math.abs(Number(raBody.medianCostUsd) - expMedian) < 1e-9
  && Math.abs(Number(raBody.p90CostUsd) - expP90) < 1e-9
const withinObserved = Number(raBody.medianCostUsd) >= positiveCosts[0] - 1e-9
  && Number(raBody.p90CostUsd) <= positiveCosts[positiveCosts.length - 1] + 1e-9
  && Number(raBody.p90CostUsd) >= Number(raBody.medianCostUsd) - 1e-9
result.recentActuals = { ...(result.recentActuals as object), primary: raBody, expected: { median: expMedian, p90: expP90 } }
assert('p3_4_recent_actuals_agent_scope', raBody.scope === 'profile' && raBody.n >= 5,
  { scope: raBody.scope, n: raBody.n, note: "'profile' == the agent scope (RecentActualsScope enum)" })
assert('p3_4_recent_actuals_median_p90_consistent', medianFinite && medianConsistent && withinObserved,
  { apiMedian: raBody.medianCostUsd, apiP90: raBody.p90CostUsd, expMedian, expP90, withinObserved })

// Fallback path: a bogus/thin profile (no projectId) must fall back to project|global.
const raFb = await api('GET', `/api/metrics/recent-actuals?profileId=${encodeURIComponent('nonexistent-profile-' + randomUUID())}`)
if (raFb.status !== 200) await fail(`GET recent-actuals (fallback) -> ${raFb.status}`)
result.recentActuals = { ...(result.recentActuals as object), fallback: raFb.body }
assert('p3_4_recent_actuals_falls_back', raFb.body.scope === 'project' || raFb.body.scope === 'global',
  { scope: raFb.body.scope, n: raFb.body.n })

// cost-rollup groupBy=project — bucket sum == totalCostUsd == measured total.
const rollupProject = await api('GET', '/api/metrics/cost-rollup?groupBy=project')
if (rollupProject.status !== 200) await fail(`GET cost-rollup?groupBy=project -> ${rollupProject.status}`)
const rp = rollupProject.body
const rpBucketSum = (rp.buckets ?? []).reduce((s: number, b: any) => s + Number(b.costUsd), 0)
const rpInternal = Math.abs(rpBucketSum - Number(rp.totalCostUsd)) < 1e-9
const rpVsMeasured = Math.abs(Number(rp.totalCostUsd) - measuredTotal) < 1e-6
result.costRollup = { ...(result.costRollup as object), project: { totalCostUsd: rp.totalCostUsd, bucketSum: rpBucketSum, buckets: rp.buckets, measuredTotal } }
assert('p3_4_cost_rollup_project_sum_eq_measured', rpInternal && rpVsMeasured,
  { totalCostUsd: rp.totalCostUsd, bucketSum: rpBucketSum, measuredTotal: Number(measuredTotal.toFixed(6)) })

// cost-rollup groupBy=day — same conservation (bonus).
const rollupDay = await api('GET', '/api/metrics/cost-rollup?groupBy=day')
if (rollupDay.status !== 200) await fail(`GET cost-rollup?groupBy=day -> ${rollupDay.status}`)
const rd = rollupDay.body
const rdBucketSum = (rd.buckets ?? []).reduce((s: number, b: any) => s + Number(b.costUsd), 0)
const rdVsMeasured = Math.abs(Number(rd.totalCostUsd) - measuredTotal) < 1e-6 && Math.abs(rdBucketSum - Number(rd.totalCostUsd)) < 1e-9
result.costRollup = { ...(result.costRollup as object), day: { totalCostUsd: rd.totalCostUsd, bucketSum: rdBucketSum, buckets: rd.buckets } }
assert('p3_4_cost_rollup_day_sum_eq_measured', rdVsMeasured,
  { totalCostUsd: rd.totalCostUsd, bucketSum: rdBucketSum, measuredTotal: Number(measuredTotal.toFixed(6)) })

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 5 — no-price-tables grep gate re-affirm (D-087) — 1/1 GREEN
// ══════════════════════════════════════════════════════════════════════════════
const gate = await execa('pnpm', ['exec', 'vitest', 'run', 'test/no-price-tables.test.ts'],
  { cwd: CORE_DIR, reject: false, env: { ...process.env } })
const gateOut = `${gate.stdout}\n${gate.stderr}`
// Parse the "Tests  N passed (M)" line for reporting; exitCode is the HARD gate (a green
// single-test run always exits 0), so a vitest output-format change can't spuriously fail us.
const passMatch = gateOut.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
const passed = passMatch ? Number(passMatch[1]) : null
const totalTests = passMatch ? Number(passMatch[2]) : null
const noFailures = !/\b[1-9]\d*\s+failed\b/.test(gateOut)
result.grepGate = { exitCode: gate.exitCode, passed, totalTests, noFailures, tail: gateOut.split('\n').slice(-12).join('\n') }
assert('p3_5_no_price_tables_gate_green', gate.exitCode === 0 && noFailures && (passed === null || passed === 1),
  { exitCode: gate.exitCode, passed, totalTests, noFailures })

// ══════════════════════════════════════════════════════════════════════════════
// FINISH
// ══════════════════════════════════════════════════════════════════════════════
finishResult()
await cleanup()

const failed = assertions.filter(a => !a.ok)
console.log(`\n[smoke] TOTAL MEASURED COST: $${measuredTotal.toFixed(4)} (cap $${COST_CAP_USD})${measuredTotal > COST_CAP_USD ? '  ** BUDGET EXCEEDED **' : ''} across ${runs.length} dispatches`)
console.log(`[smoke] Ollama unavailable -> narrative bullets degraded to '${result.ollama && (result.ollama as any).bulletsState}' (populated path covered by Lane A unit test)`)
if (failed.length > 0) {
  console.error(`\nSMOKE FAIL — ${failed.length} assertion(s): ${failed.map(a => a.name).join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — E-09 feed + E-08 narrative degrade + E-13 measured cost lens (recent-actuals agent-scope + fallback + cost-rollup conservation) + no-price-tables gate all verified with measured costs.')
