/**
 * UI Simplification — LIVE SMOKE (Task 20 Step 3). Drives a REAL dispatch chain
 * against an ISOLATED core (fresh K_DATA_DIR, spare port 3218, org loops off —
 * NEVER the real data/ dir) proving the post-restructure surfaces actually work
 * end-to-end, not just render (that's the e2e route-matrix's job):
 *
 *   1. Multi-thread K: create an empty thread (POST /api/k/threads), ask a
 *      benign non-escalating question on it (POST /api/k/ask with threadId),
 *      poll the returned run to a terminal status, then GET the thread back
 *      and confirm BOTH turns are present (user + k) and the thread picked up
 *      an auto-title (askK stamps it from the first message — k-thread.ts).
 *   2. memory_save: a second ask on the SAME thread asking K to remember a
 *      durable fact, worded to stay NON-ESCALATING per routeForMessage
 *      (shared/src/types.ts) — no frontend/backend/systems/security/network
 *      or generic-engineering trigger words — so K handles it itself instead
 *      of delegating to the Chief. Poll to terminal, then check GET
 *      /api/memories for the remembered fact AND GET /api/notifications for a
 *      memory_saved row. Per the task brief: if K does not invoke the tool
 *      this ask, that is recorded as a FINDING (a charter-wording gap), not
 *      silently faked as a pass — it does NOT flip the script's exit code.
 *   3. Home-layout reboot survival: PUT a layout, KILL the core process,
 *      respawn it against the SAME data dir, GET the layout back — proves
 *      app_config (not an in-memory cache) is the source of truth
 *      (core/src/config-store.ts homeLayout/setHomeLayout).
 *   4. The legacy singular /api/k/thread (no "s") is gone — 404, not silently
 *      redirected or 200 (grepped: zero occurrences left in core/src).
 *
 * Every dispatch pins MODEL (haiku); costs are MEASURED (run.costUsd,
 * CLI-reported — never estimated) with a hard $2 abort cap (expected << $0.10
 * for 2 tiny asks). LIVE — never runs in CI.
 *
 * No third-party imports (Node builtins + global fetch only): this script
 * lives at repo-root scripts/, outside any single workspace package, so it
 * cannot resolve another package's node_modules (execa, better-sqlite3) the
 * way core/probes/*.mts do. It still needs a TypeScript loader to execute the
 * .mts syntax itself — run it with cwd=core so `--import tsx` resolves core's
 * own devDependency; the script's own imports are Node builtins so requiring
 * NOTHING beyond that loader.
 *
 * Run from repo root:
 *   pnpm --filter @k/core exec -- node --import tsx ../scripts/smoke-ui-simpl.mts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')                     // k/
const CORE_DIR = path.join(REPO_ROOT, 'core')                        // k/core
const OUT_DIR = path.join(REPO_ROOT, 'tasks', 'ui-simpl-evidence')   // COMMITTED evidence dir (not gitignored)
const PORT = 3218                                                     // spare (P0 3210, P1 3215, P2 3216, P3 3217)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const MODEL = 'claude-haiku-4-5-20251001'
const COST_CAP_USD = 2                                                // hard safety abort (ceiling; expected << $0.10)
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])

// Worded to avoid EVERY routeForMessage trigger (K_LOGISTICS_RULES / K_ROUTE_RULES /
// K_ENGINEERING_RE in shared/src/types.ts) so both asks stay non-escalating and K
// handles them itself as cheap resumable one-shots, never delegating to the Chief.
const ASK_1 = 'Say hello in one short sentence and name one interesting fact about octopuses.'
const ASK_2_MEMORY = 'Please remember for future conversations: my favorite text editor is vim.'
const MEMORY_NEEDLE = /vim/i

fs.mkdirSync(OUT_DIR, { recursive: true })

// ── result accounting ─────────────────────────────────────────────────────────
type RunRecord = { label: string; id: string; status: string; costUsd: number }
const assertions: { name: string; ok: boolean; hard: boolean; detail?: unknown }[] = []
const findings: string[] = []
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  model: MODEL,
  port: PORT,
  runs: [] as RunRecord[],
  totalCostUsd: 0,
  budgetCapUsd: COST_CAP_USD,
  budgetExceeded: false,
  assertions,
  findings,
  thread: {} as Record<string, unknown>,
  memory: {} as Record<string, unknown>,
  homeLayout: {} as Record<string, unknown>,
  legacyRoute: {} as Record<string, unknown>,
  info: {} as Record<string, unknown>,
}
const runs = result.runs as RunRecord[]

/** `hard` assertions gate the process exit code; soft ones (the memory tool-call,
 *  per the brief's explicit "report honestly, don't fake it" instruction) are
 *  recorded and surfaced but never flip PASS to FAIL on their own. */
function assert(name: string, ok: boolean, hard: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, hard, detail })
  console.log(`[smoke] ${ok ? 'OK  ' : 'FAIL'} ${hard ? '' : '(soft) '}${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  return ok
}

// ── isolated data dir (fresh — NEVER the real data/ dir) ──────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ui-simpl-smoke-data-'))
console.log(`[smoke] isolated data dir: ${dataDir}`)

const myRunIds: string[] = []

// ── isolated core boot/kill/health (plain child_process — no execa dep) ───────
function spawnCore(): ChildProcess {
  const c = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: CORE_DIR,
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
  c.stdout?.on('data', (b: Buffer) => process.stdout.write(`[core] ${b}`))
  c.stderr?.on('data', (b: Buffer) => process.stdout.write(`[core!] ${b}`))
  return c
}

/** Await a spawned process's own exit (never rejects — mirrors execa({reject:false})). */
function execFileWait(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    p.once('exit', () => resolve())
    p.once('error', () => resolve())
  })
}

/** Await `c`'s own 'exit' event, resolving immediately if it already fired. */
function awaitExit(c: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve()
    c.once('exit', () => resolve())
    setTimeout(resolve, timeoutMs)
  })
}

async function killCore(c: ChildProcess): Promise<void> {
  if (c.pid && process.platform === 'win32') {
    await execFileWait('taskkill', ['/pid', String(c.pid), '/T', '/F'])
  } else {
    try { c.kill('SIGTERM') } catch { /* gone */ }
  }
  await awaitExit(c, 5000)
  try { c.kill('SIGKILL') } catch { /* gone */ }
}

async function waitHealthy(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function cleanup(core: ChildProcess): Promise<void> {
  await killCore(core)
  let portFree = false
  for (let i = 0; i < 10; i++) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }) }
    catch { portFree = true; break }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.log(`[smoke] port ${PORT} free after shutdown: ${portFree}`)
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); break } catch { await new Promise(r => setTimeout(r, 2000)) }
  }
  console.log(`[smoke] removed ${dataDir}: ${!fs.existsSync(dataDir)}`)
}

function finishResult(): void {
  result.finishedAt = new Date().toISOString()
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  result.totalCostUsd = total
  result.budgetExceeded = total > COST_CAP_USD
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-result.json'), JSON.stringify(result, null, 2))
}

async function fail(core: ChildProcess, msg: string): Promise<never> {
  console.error(`\nSMOKE FAIL: ${msg}`)
  result.info = { ...(result.info as object), failure: msg }
  finishResult()
  await cleanup(core)
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

async function pollRunDone(core: ChildProcess, id: string, label: string, tries = 90): Promise<any> {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const { body } = await api('GET', `/api/runs/${id}`)
    if (body && TERMINAL.has(String(body.status))) return body
  }
  await api('POST', `/api/runs/${id}/kill`)
  return fail(core, `${label} run ${id} did not reach a terminal status within ${tries * 5}s (killed)`)
}

async function recordRun(core: ChildProcess, label: string, run: any): Promise<void> {
  const rec: RunRecord = { label, id: String(run.id), status: String(run.status), costUsd: Number(run.costUsd ?? 0) }
  runs.push(rec)
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  console.log(`[smoke] run ${label} ${run.id}: ${run.status}, MEASURED $${rec.costUsd.toFixed(4)} (total $${total.toFixed(4)})`)
  if (total > COST_CAP_USD) await fail(core, `accumulated MEASURED cost $${total.toFixed(4)} exceeds the hard $${COST_CAP_USD} cap — aborting`)
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
let core = spawnCore()
if (!(await waitHealthy(60))) await fail(core, 'core did not become healthy within 60s')

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 1 — multi-thread K: new thread + ask + poll + both turns + auto-title
// ══════════════════════════════════════════════════════════════════════════════
const threadCreate = await api('POST', '/api/k/threads', {})
if (threadCreate.status !== 201) await fail(core, `POST /api/k/threads -> ${threadCreate.status}: ${JSON.stringify(threadCreate.body)}`)
const threadId = String(threadCreate.body.id)
console.log(`[smoke] thread created: ${threadId} (title=${threadCreate.body.title})`)
assert('t1_thread_created_untitled', threadCreate.body.title === null, true, { title: threadCreate.body.title })

const ask1 = await api('POST', '/api/k/ask', { message: ASK_1, model: MODEL, threadId })
if (ask1.status !== 201) await fail(core, `POST /api/k/ask (ask 1) -> ${ask1.status}: ${JSON.stringify(ask1.body)}`)
assert('t1_ask1_non_escalating', ask1.body.route?.escalates === false, true, { route: ask1.body.route })
myRunIds.push(String(ask1.body.runId))
const ask1Done = await pollRunDone(core, String(ask1.body.runId), 'ask-1', 90)
await recordRun(core, 'ask-1', ask1Done)
assert('t1_ask1_done', ask1Done.status === 'done', true, { status: ask1Done.status })

// Small settle: the k-turn append rides the same in-process run-terminal event
// that flips run.status — give the write a beat before reading the thread back.
await new Promise(r => setTimeout(r, 500))

const threadAfter1 = await api('GET', `/api/k/threads/${threadId}`)
if (threadAfter1.status !== 200) await fail(core, `GET /api/k/threads/:id (after ask 1) -> ${threadAfter1.status}`)
const turns1: any[] = threadAfter1.body.turns ?? []
const roles1 = turns1.map(t => t.role)
result.thread = {
  id: threadId,
  titleAfterAsk1: threadAfter1.body.thread?.title,
  turnsAfterAsk1: turns1.length,
  rolesAfterAsk1: roles1,
}
assert('t1_thread_has_both_turns', turns1.length >= 2 && roles1.includes('user') && roles1.includes('k'), true,
  { turns: turns1.length, roles: roles1 })
assert('t1_thread_auto_titled', typeof threadAfter1.body.thread?.title === 'string' && threadAfter1.body.thread.title.length > 0, true,
  { title: threadAfter1.body.thread?.title })

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 2 — memory_save: a real durable-memory ask (soft: report, don't fake)
// ══════════════════════════════════════════════════════════════════════════════
const ask2 = await api('POST', '/api/k/ask', { message: ASK_2_MEMORY, model: MODEL, threadId })
if (ask2.status !== 201) await fail(core, `POST /api/k/ask (ask 2, memory) -> ${ask2.status}: ${JSON.stringify(ask2.body)}`)
assert('t2_ask2_non_escalating', ask2.body.route?.escalates === false, true, { route: ask2.body.route })
myRunIds.push(String(ask2.body.runId))
const ask2Done = await pollRunDone(core, String(ask2.body.runId), 'ask-2-memory', 90)
await recordRun(core, 'ask-2-memory', ask2Done)
assert('t2_ask2_done', ask2Done.status === 'done', true, { status: ask2Done.status })

await new Promise(r => setTimeout(r, 500))

const memoriesRes = await api('GET', '/api/memories')
if (memoriesRes.status !== 200) await fail(core, `GET /api/memories -> ${memoriesRes.status}`)
const memories: any[] = memoriesRes.body.memories ?? []
const vimMemory = memories.find(m => MEMORY_NEEDLE.test(String(m.content ?? '')))

const notifRes = await api('GET', '/api/notifications?limit=50')
if (notifRes.status !== 200) await fail(core, `GET /api/notifications -> ${notifRes.status}`)
const notifications: any[] = notifRes.body.notifications ?? []
const memorySavedNotif = notifications.find(n => n.eventKey === 'memory_saved')

result.memory = {
  askText: ASK_2_MEMORY,
  memoriesCount: memories.length,
  vimMemoryFound: !!vimMemory,
  vimMemoryContent: vimMemory?.content ?? null,
  memorySavedNotifFound: !!memorySavedNotif,
  memorySavedNotifTitle: memorySavedNotif?.title ?? null,
}
const memoryToolCalled = !!vimMemory && !!memorySavedNotif
assert('t2_memory_save_tool_invoked', memoryToolCalled, false,
  { vimMemoryFound: !!vimMemory, memorySavedNotifFound: !!memorySavedNotif })
if (!memoryToolCalled) {
  findings.push(
    'K did not (visibly) call memory_save for the wording "' + ASK_2_MEMORY + '" — ' +
    `GET /api/memories vim-match=${!!vimMemory}, GET /api/notifications memory_saved-row=${!!memorySavedNotif}. ` +
    'Per the task brief this is reported as a FINDING on charter/tool-invocation reliability, not treated as a hard smoke failure.',
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 3 — home-layout reboot survival (kill + respawn against the SAME data dir)
// ══════════════════════════════════════════════════════════════════════════════
const layout = {
  widgets: [
    { id: 'cost_today', x: 0, y: 0, w: 2, h: 1 },
    { id: 'notes', x: 2, y: 0, w: 1, h: 2 },
  ],
}
const putLayout = await api('PUT', '/api/settings/home-layout', layout)
if (putLayout.status !== 200) await fail(core, `PUT /api/settings/home-layout -> ${putLayout.status}: ${JSON.stringify(putLayout.body)}`)
assert('t3_put_layout_ok', JSON.stringify(putLayout.body.layout) === JSON.stringify(layout), true, { returned: putLayout.body.layout })

console.log('[smoke] killing core to prove reboot survival...')
await killCore(core)
let portFreeBeforeRespawn = false
for (let i = 0; i < 10; i++) {
  try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }) }
  catch { portFreeBeforeRespawn = true; break }
  await new Promise(r => setTimeout(r, 1000))
}
if (!portFreeBeforeRespawn) await fail(core, `port ${PORT} did not free up after killing core for the reboot-survival check`)

core = spawnCore() // SAME dataDir — this is the whole point of the check
if (!(await waitHealthy(60))) await fail(core, 'core did not become healthy within 60s after the reboot-survival respawn')

const getLayout = await api('GET', '/api/settings/home-layout')
if (getLayout.status !== 200) await fail(core, `GET /api/settings/home-layout (after respawn) -> ${getLayout.status}`)
result.homeLayout = { put: layout, getAfterRespawn: getLayout.body.layout }
assert('t3_layout_survives_reboot', JSON.stringify(getLayout.body.layout) === JSON.stringify(layout), true,
  { expected: layout, actual: getLayout.body.layout })

// ══════════════════════════════════════════════════════════════════════════════
// ASSERTION 4 — legacy singular /api/k/thread (no "s") is gone — 404
// ══════════════════════════════════════════════════════════════════════════════
const legacy = await fetch(`${BASE}/api/k/thread`, { headers: AUTH })
result.legacyRoute = { status: legacy.status }
assert('t4_legacy_singular_thread_route_404', legacy.status === 404, true, { status: legacy.status })

// ══════════════════════════════════════════════════════════════════════════════
// FINISH
// ══════════════════════════════════════════════════════════════════════════════
finishResult()
await cleanup(core)

const measuredTotal = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
const hardFailed = assertions.filter(a => a.hard && !a.ok)
const softFailed = assertions.filter(a => !a.hard && !a.ok)
console.log(`\n[smoke] TOTAL MEASURED COST: $${measuredTotal.toFixed(4)} (cap $${COST_CAP_USD})${measuredTotal > COST_CAP_USD ? '  ** BUDGET EXCEEDED **' : ''} across ${runs.length} dispatches`)
if (softFailed.length > 0) {
  console.log(`[smoke] ${softFailed.length} soft (non-gating) finding(s): ${softFailed.map(a => a.name).join(', ')}`)
  for (const f of findings) console.log(`[smoke] FINDING: ${f}`)
}
if (hardFailed.length > 0) {
  console.error(`\nSMOKE FAIL — ${hardFailed.length} hard assertion(s): ${hardFailed.map(a => a.name).join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — multi-thread K (turns + auto-title) + home-layout reboot survival + legacy /api/k/thread 404 all verified with measured costs.' +
  (softFailed.length > 0 ? ' (memory_save tool-invocation recorded as a soft finding — see findings[].)' : ' memory_save tool-invocation also confirmed.'))
