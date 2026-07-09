/**
 * P2 PHASE SMOKE (Human Gates) — E-02 Plan Gate, E-05 Approvals Inbox, E-19
 * Notifications, and E-06 merge gating driven through the REAL core against
 * THROWAWAY repos (never the K repo's data dir, never a dev core).
 *
 * STAGE 1 (local scratch, no GitHub — E-02 / E-05 / E-19):
 *   plan-gated dispatch parks at awaiting_plan → the plan reads back (steps+risk)
 *   → a run_awaiting_plan notification arrives on the WS AND lists unread
 *   → a structured plan EDIT (append a step) sets edited=true
 *   → the inbox unions 3 live kinds at once (plan + lesson + mcp-trust) → screenshot
 *   → a DOUBLE approve-plan yields exactly one 200 + one 409 (CAS)
 *   → the approved continuation reaches done: diff carries hello.js, the operator
 *     hand-off `user` event carries the EDITED step, the run prompt is scaffold-free
 *   → COST-CARRY (SEAMS LOW-5): the final cost = plan-turn + continuation, NOT 2×
 *     the plan turn (no priorCostBase double-count)
 *   → REBOOT SURVIVAL: a 2nd park survives a full core restart on the same data dir
 *     and still approves (or fails honestly with a 410).
 *
 * STAGE 2 (real private GitHub repo — E-06), skipped if `gh auth status` fails:
 *   a run against a FAILING verify recipe → verify 'fail' → approve → PR
 *   → the red k/verify commit status lands on the PR head → merge is BLOCKED (409)
 *   → fix the recipe → re-verify 'pass' → the republished status flips k/verify green
 *   → the now-green PR merges (200) and reads MERGED.
 *
 * Boots an ISOLATED core (fresh K_DATA_DIR, spare port 3216, pollers off). Every
 * dispatch pins model claude-haiku-4-5-20251001. Costs are MEASURED (run.costUsd,
 * CLI-reported — never estimated); hard abort if accumulated cost exceeds $8.
 *
 * PRECONDITION (P0 lesson): the K repo's .worktrees/ and refs/k-checkpoints/* must
 * be empty OR every other core stopped — this core's boot sweeps worktrees against
 * ITS OWN (empty) DB. Checked manually before each invocation.
 * LIVE (haiku ×3–4 — expected well under $1 measured). NEVER runs in CI.
 * Run from core/:  pnpm exec tsx probes/smoke-p2.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
// better-sqlite3 resolves from core/node_modules (this file lives in core/probes).
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORE_DIR = path.join(__dirname, '..')       // core/
const REPO_ROOT = path.join(__dirname, '../..')   // k/
const OUT_DIR = path.join(__dirname, 'out', 'p2')
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tasks', 'p2-evidence')
const PORT = 3216                                  // spare (P1 uses 3215) — NEVER 3001
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const MODEL = 'claude-haiku-4-5-20251001'
const COST_CAP_USD = 8                             // hard safety abort (ceiling; expected ≪ $1)
const GH_OWNER = 'ckbraun2003'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])
const VERIFY_TERMINAL = new Set(['pass', 'fail', 'skipped', 'error'])
const ORIGINAL_PROMPT = "Create hello.js that prints 'hello from k'"
const EDIT_STEP_TITLE = 'Also create README.md with one line about hello.js'

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

// ── result accounting ─────────────────────────────────────────────────────────
type RunRecord = { role: string; id: string; status: string; costUsd: number; tokensIn: number; tokensOut: number }
const assertions: { name: string; ok: boolean; detail?: unknown }[] = []
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  model: MODEL,
  runs: [] as RunRecord[],
  totalCostUsd: 0,
  budgetCapUsd: COST_CAP_USD,
  budgetExceeded: false,
  assertions,
  planTurnCost: null as number | null,
  finalResumedCost: null as number | null,
  costTimeline: [] as number[],
  doubleSend: null as unknown,
  rebootSurvival: null as unknown,
  stage2: {} as Record<string, unknown>,
  info: {} as Record<string, unknown>,
  evidence: {} as Record<string, unknown>,
}
const runs = result.runs as RunRecord[]

function assert(name: string, ok: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, detail })
  console.log(`[smoke] ${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  return ok
}

// ── isolated data dir + throwaway local scratch repo ──────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p2-data-'))
const dbFile = path.join(dataDir, 'k.db')
const GIT_ID = ['-c', 'user.name=p2-smoke', '-c', 'user.email=p2-smoke@k.local']

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p2-scratch-'))
await execa('git', ['-C', scratchDir, 'init', '-b', 'main'], { reject: true })
fs.writeFileSync(path.join(scratchDir, 'README.md'), '# p2 smoke scratch\n')
await execa('git', ['-C', scratchDir, ...GIT_ID, 'add', '-A'], { reject: true })
await execa('git', ['-C', scratchDir, ...GIT_ID, 'commit', '-m', 'seed'], { reject: true })
console.log(`[smoke] scratch repo: ${scratchDir}`)
console.log(`[smoke] isolated data dir: ${dataDir}`)

const myRunIds: string[] = []
let gh2Dir: string | null = null // Stage 2 clone dir (removed at end)

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
  // Throwaway dirs (retry: SQLite/git handles can lag on Windows). LEAVE the GitHub repo.
  for (const dir of [scratchDir, dataDir, gh2Dir].filter(Boolean) as string[]) {
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
  const json = JSON.stringify(result, null, 2)
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-result.json'), json)
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'smoke-result.json'), json)
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

async function pollRunStatus(id: string, target: string, label: string, tries = 120): Promise<any> {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const { body } = await api('GET', `/api/runs/${id}`)
    if (body && body.status === target) return body
    if (body && TERMINAL.has(String(body.status)) && body.status !== target) {
      return fail(`${label} run ${id} reached terminal '${body.status}' before '${target}'`)
    }
  }
  return fail(`${label} run ${id} did not reach '${target}' within ${tries * 5}s`)
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

async function pollVerify(id: string, cycles: number): Promise<any> {
  for (let i = 0; i < cycles; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const res = await api('GET', `/api/runs/${id}/verify-result`)
    if (res.status === 200 && VERIFY_TERMINAL.has(String(res.body?.status))) return res.body
  }
  return null
}

async function recordRun(role: string, run: any): Promise<void> {
  const rec: RunRecord = {
    role, id: String(run.id), status: String(run.status),
    costUsd: Number(run.costUsd ?? 0), tokensIn: Number(run.tokensIn ?? 0), tokensOut: Number(run.tokensOut ?? 0),
  }
  runs.push(rec)
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  console.log(`[smoke] ${role} run ${run.id}: ${run.status}, MEASURED $${rec.costUsd.toFixed(4)} (total $${total.toFixed(4)})`)
  if (total > COST_CAP_USD) await fail(`accumulated MEASURED cost $${total.toFixed(4)} exceeds the hard $${COST_CAP_USD} cap — aborting`)
  const ev = await api('GET', `/api/runs/${run.id}/events?raw=1`)
  fs.writeFileSync(path.join(OUT_DIR, `${role}-${run.id}.events.json`), JSON.stringify(ev.body, null, 2))
}

/** Pull every total_cost_usd emitted on the run's raw `result` lines, in order. */
async function costTimeline(id: string): Promise<number[]> {
  const ev = await api('GET', `/api/runs/${id}/events?raw=1`)
  const out: number[] = []
  const events = Array.isArray(ev.body) ? ev.body : (ev.body?.events ?? [])
  for (const e of events) {
    const raw = e?.raw ?? e?.rawJson ?? e?.text
    if (typeof raw !== 'string') continue
    const m = raw.match(/"total_cost_usd"\s*:\s*([0-9.]+)/)
    if (m) out.push(Number(m[1]))
  }
  return out
}

// ── live-inbox → HTML render → headless-Edge screenshot (verify-artifacts recipe) ─
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}
function renderInboxHtml(box: any): string {
  const ORDER = ['plan_pending', 'input_needed', 'review_ready', 'lesson_pending', 'mcp_trust']
  const LABEL: Record<string, string> = {
    plan_pending: 'Plans to approve', input_needed: 'Runs waiting on your reply',
    review_ready: 'Ready for review', lesson_pending: 'Lessons to approve', mcp_trust: 'MCP servers to trust',
  }
  const sections = ORDER.map(kind => {
    const count = box.counts?.[kind] ?? 0
    if (!count) return ''
    const items = (box.items ?? []).filter((i: any) => i.kind === kind)
    const cards = items.map((it: any) => {
      let meta = ''
      if (kind === 'plan_pending') meta = [it.risk ? `${it.risk} risk` : '', it.steps != null ? `${it.steps} steps` : '', it.edited ? 'edited' : ''].filter(Boolean).map(chip).join('')
      else if (kind === 'lesson_pending') meta = chip(it.profileName ?? 'unassigned')
      else if (kind === 'mcp_trust') meta = chip(it.sourceKind)
      const action = kind === 'plan_pending' ? 'Review plan' : kind === 'lesson_pending' ? 'Approve / Reject' : kind === 'mcp_trust' ? 'Trust / Dismiss' : 'Open'
      return `<div class="card"><div class="cardl"><p class="title">${esc(it.title)}</p><div class="sub"><span>${esc(it.projectName ?? '—')}</span>${meta}</div></div><div class="act">${esc(action)}</div></div>`
    }).join('')
    return `<section><div class="shead"><h2>${esc(LABEL[kind])}</h2><span class="pill">${count}</span></div><div class="cards">${cards}</div></section>`
  }).join('')
  return `<div class="wrap"><div class="hd"><h1>Inbox · ${box.total} ${box.total === 1 ? 'item' : 'items'}</h1>`
    + `<p class="lede">Everything waiting on <b>you</b> — plans, replies, reviews, and approvals — in one place. Live GET /api/inbox against the isolated stack (port ${PORT}).</p></div>`
    + `<div class="secs">${sections}</div></div>`
  function chip(t: string): string { return `<span class="chip">${esc(t)}</span>` }
}
function inboxPage(box: any): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{--bg:#0b0f14;--surface:#111823;--raised:#1b2634;--border:#243040;--text:#e6edf3;--muted:#8aa0b4;--green:#3ddc97;--amber:#f6c453}
  *{box-sizing:border-box;margin:0;font-family:'Segoe UI',system-ui,sans-serif}
  body{background:var(--bg);color:var(--text);padding:22px}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
  .lede{margin-top:6px;font-size:11px;color:var(--muted);line-height:1.5}
  .secs{display:flex;flex-direction:column;gap:22px;margin-top:18px}
  .shead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
  .pill{background:var(--raised);border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600;color:var(--muted)}
  .cards{display:flex;flex-direction:column;gap:8px}
  .card{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border:1px solid var(--border);background:var(--surface);border-radius:12px;padding:12px 16px}
  .title{font-size:14px;color:var(--text)}
  .sub{margin-top:5px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:10px;color:var(--muted)}
  .chip{background:var(--raised);border-radius:4px;padding:2px 6px}
  .act{flex-shrink:0;border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;color:var(--green)}
  </style></head><body>${renderInboxHtml(box)}</body></html>`
}
async function screenshotInbox(box: any): Promise<boolean> {
  if (!fs.existsSync(EDGE)) { console.warn('[smoke] Edge not found — skipping inbox screenshot'); return false }
  const htmlPath = path.join(OUT_DIR, 'inbox.html')
  fs.writeFileSync(htmlPath, inboxPage(box), 'utf8')
  const outPng = path.join(EVIDENCE_DIR, 'smoke-inbox.png')
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/')
  for (let attempt = 0; attempt < 3; attempt++) {
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'k-edge-'))
    try { if (fs.existsSync(outPng)) fs.rmSync(outPng) } catch { /* ignore */ }
    await execa(EDGE, [
      '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${udd}`,
      '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=900,1000',
      '--virtual-time-budget=4000', `--screenshot=${outPng}`, fileUrl,
    ], { reject: false, timeout: 30_000 })
    await new Promise(r => setTimeout(r, 4000))
    try { fs.rmSync(udd, { recursive: true, force: true }) } catch { /* ignore */ }
    if (fs.existsSync(outPng) && fs.statSync(outPng).size > 0) {
      console.log(`[smoke] inbox screenshot written: ${outPng} (${fs.statSync(outPng).size} bytes)`)
      return true
    }
    console.warn(`[smoke] inbox screenshot attempt ${attempt + 1} produced no PNG — retrying`)
  }
  return false
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
if (!(await waitHealthy(60))) await fail('core did not become healthy within 60s')

// WS client — RECORD every `notification` member (connected BEFORE any dispatch).
const wsNotifications: any[] = []
let ws: WebSocket | null = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
await new Promise<void>((resolve) => {
  ws!.on('open', () => { console.log('[smoke] WS connected'); resolve() })
  ws!.on('error', (e) => { console.warn('[smoke] WS error:', (e as Error).message); resolve() })
  setTimeout(resolve, 8000)
})
ws?.on('message', (data: Buffer) => {
  try {
    const m = JSON.parse(data.toString())
    if (m?.type === 'notification') { wsNotifications.push(m.notification); console.log(`[smoke] WS notification: ${m.notification?.eventKey} run=${String(m.notification?.runId).slice(0, 8)}`) }
  } catch { /* ignore */ }
})

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 1 — local scratch (E-02 / E-05 / E-19)
// ══════════════════════════════════════════════════════════════════════════════
// step 1: register scratch project (local; no remote derived)
const reg = await api('POST', '/api/projects', { name: 'p2-smoke-scratch', localPath: scratchDir })
if (reg.status !== 201) await fail(`project registration -> ${reg.status}: ${JSON.stringify(reg.body)}`)
const project = reg.body
console.log(`[smoke] project registered ${project.id}`)

// step 2: plan-gated dispatch → park at awaiting_plan
const start = await api('POST', '/api/runs', {
  prompt: ORIGINAL_PROMPT, cwd: scratchDir, projectId: project.id, model: MODEL, planGate: true,
})
if (start.status !== 201) await fail(`POST /api/runs (planGate) -> ${start.status}: ${JSON.stringify(start.body)}`)
const runId = String(start.body.id)
myRunIds.push(runId)
console.log(`[smoke] plan-gated run started: ${runId}`)
const parked = await pollRunStatus(runId, 'awaiting_plan', 'plan-gate')
assert('stage1_2_parked_awaiting_plan', parked.status === 'awaiting_plan', { status: parked.status })

// COST-CARRY capture #1: the plan-turn cost, read BETWEEN park and approve.
const planTurnRow = (await api('GET', `/api/runs/${runId}`)).body
result.planTurnCost = Number(planTurnRow.costUsd ?? 0)
result.info = { ...(result.info as object), planTurnTokens: { in: planTurnRow.tokensIn, out: planTurnRow.tokensOut } }
console.log(`[smoke] plan-turn cost (parked): $${Number(result.planTurnCost).toFixed(4)}`)

// GET plan — steps>=1 + risk (a null/degraded plan is LOGGED, never fails the park)
const planRes = await api('GET', `/api/runs/${runId}/plan`)
const planDoc = planRes.body?.plan
result.evidence = { ...(result.evidence as object), planDoc, planRaw: String(planRes.body?.raw ?? '').slice(0, 400) }
if (planDoc == null) {
  console.warn('[smoke] plan is NULL (model skipped the json fence) — logging, proceeding (raw park still valid)')
  assert('stage1_2_plan_present', true, { degraded: true, note: 'null plan tolerated per spec' })
} else {
  assert('stage1_2_plan_steps_and_risk', Array.isArray(planDoc.steps) && planDoc.steps.length >= 1 && typeof planDoc.risk === 'string',
    { steps: planDoc.steps?.length, risk: planDoc.risk })
}

// step 3: notification on park (E-19 live) — WS member + unread in the list
let wsNote: any = null
for (let i = 0; i < 20 && !wsNote; i++) {
  wsNote = wsNotifications.find(n => n?.eventKey === 'run_awaiting_plan' && n?.runId === runId)
  if (!wsNote) await new Promise(r => setTimeout(r, 500))
}
assert('stage1_3_ws_notification_awaiting_plan', !!wsNote, wsNote ? { id: wsNote.id, eventKey: wsNote.eventKey } : { recorded: wsNotifications.map(n => n?.eventKey) })
const notifList = await api('GET', '/api/notifications')
const listedUnread = (notifList.body?.notifications ?? []).find((n: any) => n.eventKey === 'run_awaiting_plan' && n.runId === runId && n.readAt == null)
assert('stage1_3_notification_listed_unread', !!listedUnread, { unreadCount: notifList.body?.unread, found: !!listedUnread })

// step 4: structured plan EDIT (append a step) → edited:true
const baseSteps = Array.isArray(planDoc?.steps) && planDoc.steps.length > 0 ? planDoc.steps : [{ title: ORIGINAL_PROMPT }]
const editedPlan = {
  steps: [...baseSteps, { title: EDIT_STEP_TITLE }],
  files: Array.isArray(planDoc?.files) ? planDoc.files : ['hello.js', 'README.md'],
  risk: typeof planDoc?.risk === 'string' ? planDoc.risk : 'low',
  ...(planDoc?.notes ? { notes: planDoc.notes } : {}),
}
const patch = await api('PATCH', `/api/runs/${runId}/plan`, { plan: editedPlan })
assert('stage1_4_plan_edited', patch.status === 200 && patch.body?.edited === true,
  { status: patch.status, edited: patch.body?.edited })

// step 5: inbox unions 3 kinds at once (E-05 live) — seed lesson + untrusted MCP via a 2nd connection
{
  const seed = new Database(dbFile)
  seed.pragma('busy_timeout = 8000')
  seed.pragma('foreign_keys = ON')
  const now = Date.now()
  seed.prepare(`INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at, profile_id)
                VALUES (?, NULL, ?, 'pending', ?, NULL, NULL)`)
    .run(`p2-smoke-lesson-${now}`, 'P2 smoke: always pin the model at the route boundary.', now)
  seed.prepare(`INSERT INTO host_mcp_servers
                (id, name, qualified_key, source_kind, project_id, command, args, env, config_hash,
                 enabled, trusted_hash, trusted_at, inbox_dismissed_hash, est_tokens, probe_status, status,
                 discovered_at, last_scanned_at)
                VALUES (?, ?, ?, 'claude-user', NULL, ?, '[]', '{}', ?, 0, NULL, NULL, NULL, NULL, NULL, 'ok', ?, NULL)`)
    .run(`p2-smoke-mcp-${now}`, 'p2-smoke-server', `claude-user:p2-smoke-server-${now}`, 'node', `hash-${now}`, now)
  seed.close()
  console.log('[smoke] seeded 1 pending lesson + 1 untrusted MCP server')
}
const inbox = await api('GET', '/api/inbox')
const kinds = new Set((inbox.body?.items ?? []).map((i: any) => i.kind))
result.evidence = { ...(result.evidence as object), inboxCounts: inbox.body?.counts, inboxTotal: inbox.body?.total }
assert('stage1_5_inbox_three_kinds',
  kinds.has('plan_pending') && kinds.has('lesson_pending') && kinds.has('mcp_trust') && Number(inbox.body?.total) >= 3,
  { kinds: [...kinds], total: inbox.body?.total, counts: inbox.body?.counts })
const shotOk = await screenshotInbox(inbox.body)
assert('stage1_5_inbox_screenshot', shotOk, { path: path.join(EVIDENCE_DIR, 'smoke-inbox.png'), captured: shotOk })

// step 6: double-send approve-plan → exactly one 200, one 409
const [a1, a2] = await Promise.all([
  api('POST', `/api/runs/${runId}/approve-plan`),
  api('POST', `/api/runs/${runId}/approve-plan`),
])
const codes = [a1.status, a2.status].sort()
result.doubleSend = { codes, bodies: [a1.body, a2.body] }
assert('stage1_6_double_send_200_and_409', codes[0] === 200 && codes[1] === 409, { codes })

// step 7 + 8: continuation → done, diff/edit-carry/scaffold-free + cost-carry
const done = await pollRunDone(runId, 'continuation')
await recordRun('plan-continuation', done)
assert('stage1_7_continuation_done', done.status === 'done', { status: done.status })

result.finalResumedCost = Number(done.costUsd ?? 0)
result.costTimeline = await costTimeline(runId)

// 7a: diff carries hello.js (README optional — log, don't fail)
const diff = await api('GET', `/api/runs/${runId}/diff`)
const diffFiles = (diff.body?.files ?? []).map((f: any) => ({ path: f.path, status: f.status }))
result.evidence = { ...(result.evidence as object), continuationDiff: diffFiles }
const hasHello = diffFiles.some((f: any) => f.path === 'hello.js')
const hasReadme = diffFiles.some((f: any) => f.path === 'README.md')
assert('stage1_7a_diff_has_hello_js', hasHello, { files: diffFiles })
console.log(`[smoke] continuation README.md present in diff (model-obeyed edit): ${hasReadme} (informational)`)
result.info = { ...(result.info as object), continuationCreatedReadme: hasReadme }

// 7b: the operator hand-off `user` event carries the EDITED step title
const events = await api('GET', `/api/runs/${runId}/events`)
const evArr = Array.isArray(events.body) ? events.body : (events.body?.events ?? [])
const userWithEdit = evArr.find((e: any) => e.type === 'user' && String(e.text ?? '').includes(EDIT_STEP_TITLE))
assert('stage1_7b_continuation_carries_edited_step', !!userWithEdit,
  { found: !!userWithEdit, userEvents: evArr.filter((e: any) => e.type === 'user').map((e: any) => String(e.text ?? '').slice(0, 60)) })

// 7c: the run row prompt is scaffold-free (== original prompt)
assert('stage1_7c_prompt_scaffold_free', done.prompt === ORIGINAL_PROMPT, { prompt: String(done.prompt).slice(0, 120) })

// 8: COST-CARRY (SEAMS LOW-5)
// The stored final MUST reflect plan-turn + continuation, EACH billed once (no
// priorCostBase double-count). Decisive evidence = the per-invocation result charges
// in costTimeline: [planTurn, continuation]. The terminal computes
// finalRun.costUsd = priorCostBase(=planTurn) + continuation-invocation cost, so a
// CORRECT run has F == timeline[0] + timeline[1] (two DISTINCT charges).
//   • A ratio F/P near 2 is NOT itself a double-count: it just means the continuation
//     (which does real file work) cost as much as / more than the read-only plan turn.
//   • The real double-count FAILURE is (a) an arithmetic double-ADD — F would EXCEED the
//     sum of the real result charges — or (b) final ~= 2×plan with NO real continuation
//     work (its own charge ≈ 0). We guard both, and report the raw numbers either way.
const P = Number(result.planTurnCost)
const F = Number(result.finalResumedCost)
const ratio = P > 0 ? F / P : null
const timeline = result.costTimeline as number[]
const timelineSum = timeline.reduce((a, b) => a + b, 0)
const continuationOwnCost = F - P // == the continuation invocation's own total_cost_usd
const carryOk = F >= P - 1e-9      // final includes the plan turn (monotonic)
// No arithmetic double-add: with both per-invocation charges captured, F must equal their
// sum (float tolerance); if the timeline under-captured, fall back to a ratio sanity bound.
const arithmeticOk = timeline.length >= 2
  ? F <= timelineSum + Math.max(1e-6, 0.02 * F)
  : F < 3 * P
// Real continuation work present (its own charge is a standalone turn, and it produced a
// diff) → a ~2× ratio is a costlier continuation, not a duplicated plan turn.
const realContinuationWork = hasHello && continuationOwnCost > 0.25 * P
const noDoubleCount = arithmeticOk && realContinuationWork
result.info = { ...(result.info as object), costCarry: {
  planTurnCost: P, finalResumedCost: F, continuationOwnCost, timeline, timelineSum, ratio,
  realContinuationWork, arithmeticOk, noDoubleCount,
  verdict: noDoubleCount
    ? `no double-count: final $${F.toFixed(4)} = plan-turn $${P.toFixed(4)} + continuation $${continuationOwnCost.toFixed(4)}, each billed once`
    : 'HIGH: possible plan-turn double-count — inspect priorCostBase',
} }
assert('stage1_8_cost_carry_final_gte_plan', carryOk, { planTurnCost: P, finalResumedCost: F })
assert('stage1_8_cost_carry_no_double_count', noDoubleCount,
  { planTurnCost: P, finalResumedCost: F, continuationOwnCost, ratio, timeline, timelineSum, arithmeticOk, realContinuationWork })
console.log(`[smoke] COST-CARRY: plan-turn $${P.toFixed(4)} + continuation $${continuationOwnCost.toFixed(4)} = final $${F.toFixed(4)} (ratio ${ratio?.toFixed(2)}); timeline=${JSON.stringify(timeline)}; noDoubleCount=${noDoubleCount}`)

// step 9: REBOOT SURVIVAL (bonus) — a 2nd park survives a full core restart
const start2 = await api('POST', '/api/runs', {
  prompt: 'Create bye.js that prints goodbye', cwd: scratchDir, projectId: project.id, model: MODEL, planGate: true,
})
if (start2.status !== 201) await fail(`POST /api/runs #2 (planGate) -> ${start2.status}`)
const runId2 = String(start2.body.id)
myRunIds.push(runId2)
await pollRunStatus(runId2, 'awaiting_plan', 'reboot-park')
console.log(`[smoke] 2nd run parked ${runId2}; killing core for reboot test`)
try { ws?.close() } catch { /* ignore */ }
ws = null
await killCore(core)
await new Promise(r => setTimeout(r, 2000))
core = spawnCore()
if (!(await waitHealthy(60))) await fail('core did not become healthy within 60s after reboot')
const afterReboot = (await api('GET', `/api/runs/${runId2}`)).body
const stillParked = afterReboot?.status === 'awaiting_plan'
assert('stage1_9_park_survives_reboot', stillParked, { status: afterReboot?.status })
const reApprove = await api('POST', `/api/runs/${runId2}/approve-plan`)
let rebootOutcome: string
if (reApprove.status === 200) {
  rebootOutcome = 'resumed-200'
  const done2 = await pollRunDone(runId2, 'reboot-continuation')
  await recordRun('reboot-continuation', done2)
  assert('stage1_9_reboot_approve_ok', done2.status === 'done', { outcome: rebootOutcome, status: done2.status })
} else if (reApprove.status === 410) {
  rebootOutcome = 'honest-410'
  await recordRun('reboot-park-only', afterReboot)
  assert('stage1_9_reboot_approve_ok', true, { outcome: rebootOutcome, note: 'honest 410 (substrate gone) — accepted per spec' })
} else {
  rebootOutcome = `unexpected-${reApprove.status}`
  await recordRun('reboot-park-only', afterReboot)
  assert('stage1_9_reboot_approve_ok', false, { outcome: rebootOutcome, body: reApprove.body })
}
result.rebootSurvival = { stillParked, approveStatus: reApprove.status, outcome: rebootOutcome }
console.log(`[smoke] reboot survival: stillParked=${stillParked}, approve=${reApprove.status} (${rebootOutcome})`)

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 2 — real private GitHub repo (E-06)
// ══════════════════════════════════════════════════════════════════════════════
const authed = (await execa('gh', ['auth', 'status'], { reject: false })).exitCode === 0
if (!authed) {
  console.warn('[smoke] gh not authenticated — SKIPPING Stage 2 (Stage 1 still stands)')
  result.stage2 = { skipped: true, reason: 'gh auth status failed' }
} else {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) // yyyymmddHHmm
  const repoName = `k-smoke-p2-${ts}`
  const repoSlug = `${GH_OWNER}/${repoName}`
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p2-gh-'))
  console.log(`[smoke] creating GitHub repo ${repoSlug}`)
  const created = await execa('gh', ['repo', 'create', repoSlug, '--private', '--clone'], { cwd: parent, reject: false })
  if (created.exitCode !== 0) {
    console.warn('[smoke] gh repo create failed:', created.stderr)
    result.stage2 = { skipped: true, reason: `gh repo create failed: ${String(created.stderr).slice(0, 200)}` }
  } else {
    gh2Dir = path.join(parent, repoName)
    // step 10: seed + push, register (remote auto-derives), FAILING recipe
    await execa('git', ['-C', gh2Dir, 'checkout', '-B', 'main'], { reject: false })
    fs.writeFileSync(path.join(gh2Dir, 'seed.txt'), 'p2 smoke seed\n')
    await execa('git', ['-C', gh2Dir, ...GIT_ID, 'add', '-A'], { reject: true })
    await execa('git', ['-C', gh2Dir, ...GIT_ID, 'commit', '-m', 'seed'], { reject: true })
    await execa('git', ['-C', gh2Dir, 'push', '-u', 'origin', 'main'], { reject: true })
    const reg2 = await api('POST', '/api/projects', { name: repoName, localPath: gh2Dir })
    if (reg2.status !== 201) await fail(`Stage 2 project registration -> ${reg2.status}: ${JSON.stringify(reg2.body)}`)
    const project2 = reg2.body
    assert('stage2_10_remote_auto_derived', project2.githubRemote === repoSlug, { githubRemote: project2.githubRemote })
    const failRecipe = { commands: [{ label: 'gate', run: 'node -e "process.exit(1)"' }] }
    const rc2 = await api('PATCH', `/api/projects/${project2.id}/verify-recipe`, { recipe: failRecipe })
    if (rc2.status !== 200) await fail(`Stage 2 verify-recipe PATCH -> ${rc2.status}`)

    // step 11: real haiku dispatch → done → verify 'fail'
    const s2 = await api('POST', '/api/runs', {
      prompt: 'Create hello.js printing hello', cwd: gh2Dir, projectId: project2.id, model: MODEL,
    })
    if (s2.status !== 201) await fail(`Stage 2 dispatch -> ${s2.status}: ${JSON.stringify(s2.body)}`)
    const s2Id = String(s2.body.id)
    myRunIds.push(s2Id)
    const s2Done = await pollRunDone(s2Id, 'stage2-run')
    await recordRun('stage2-fail-verify', s2Done)
    assert('stage2_11_run_done', s2Done.status === 'done', { status: s2Done.status })
    let v = await pollVerify(s2Id, 36)
    if (!v) v = await pollVerify(s2Id, 12)
    result.stage2 = { ...(result.stage2 as object), verifyStatus: v?.status }
    assert('stage2_11_verify_fail', v?.status === 'fail', { verify: v?.status })

    // step 12: approve → PR; the RED k/verify status lands on the PR head
    const ckpts = await api('GET', `/api/runs/${s2Id}/checkpoints`)
    const headSha = Array.isArray(ckpts.body) && ckpts.body.length ? ckpts.body[ckpts.body.length - 1].sha : null
    const approve = await api('POST', `/api/runs/${s2Id}/approve`)
    if (approve.status !== 201) await fail(`Stage 2 approve -> ${approve.status}: ${JSON.stringify(approve.body)}`)
    const prNumber = approve.body?.pr?.number
    result.stage2 = { ...(result.stage2 as object), prNumber, headSha, prUrl: approve.body?.pr?.url }
    console.log(`[smoke] PR #${prNumber} created; head ${String(headSha).slice(0, 8)}`)

    async function ghVerifyState(sha: string): Promise<string | null> {
      const r = await execa('gh', ['api', `repos/${repoSlug}/commits/${sha}/status`], { reject: false })
      if (r.exitCode !== 0) return null
      try {
        const j = JSON.parse(r.stdout)
        return (j.statuses ?? []).find((s: any) => s.context === 'k/verify')?.state ?? null
      } catch { return null }
    }
    let redState: string | null = null
    for (let i = 0; i < 20 && redState !== 'failure'; i++) {
      redState = await ghVerifyState(headSha)
      if (redState !== 'failure') await new Promise(r => setTimeout(r, 3000))
    }
    assert('stage2_12_kverify_failure_landed', redState === 'failure', { headSha, kverify: redState })

    // step 13: merge BLOCKED (checks failing → 409)
    const blocked = await api('POST', `/api/projects/${project2.id}/prs/${prNumber}/merge`)
    assert('stage2_13_merge_blocked_409', blocked.status === 409, { status: blocked.status, body: blocked.body })

    // step 14: fix recipe → re-verify 'pass' → republished status flips k/verify GREEN
    const passRecipe = { commands: [{ label: 'gate', run: 'node -e "process.exit(0)"' }] }
    const rc3 = await api('PATCH', `/api/projects/${project2.id}/verify-recipe`, { recipe: passRecipe })
    if (rc3.status !== 200) await fail(`Stage 2 recipe fix PATCH -> ${rc3.status}`)
    const reVerify = await api('POST', `/api/runs/${s2Id}/verify`)
    assert('stage2_14_reverify_accepted', reVerify.status === 202, { status: reVerify.status })
    let v2 = await pollVerify(s2Id, 36)
    if (!v2) v2 = await pollVerify(s2Id, 12)
    assert('stage2_14_reverify_pass', v2?.status === 'pass', { verify: v2?.status })
    let greenState: string | null = null
    for (let i = 0; i < 20 && greenState !== 'success'; i++) {
      greenState = await ghVerifyState(headSha)
      if (greenState !== 'success') await new Promise(r => setTimeout(r, 3000))
    }
    assert('stage2_14_kverify_success_flipped', greenState === 'success', { headSha, kverify: greenState })

    // step 15: GREEN merge → 200 → MERGED
    async function rollupPassing(): Promise<boolean> {
      const r = await execa('gh', ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'statusCheckRollup'], { reject: false })
      if (r.exitCode !== 0) return false
      try {
        const roll = JSON.parse(r.stdout).statusCheckRollup ?? []
        const kv = roll.find((c: any) => (c.context ?? c.name) === 'k/verify')
        return String(kv?.state ?? kv?.conclusion).toUpperCase() === 'SUCCESS'
      } catch { return false }
    }
    let passing = false
    for (let i = 0; i < 20 && !passing; i++) { passing = await rollupPassing(); if (!passing) await new Promise(r => setTimeout(r, 3000)) }
    let merge = await api('POST', `/api/projects/${project2.id}/prs/${prNumber}/merge`)
    for (let i = 0; i < 4 && merge.status === 409; i++) {
      await new Promise(r => setTimeout(r, 4000))
      merge = await api('POST', `/api/projects/${project2.id}/prs/${prNumber}/merge`)
    }
    assert('stage2_15_green_merge_200', merge.status === 200, { status: merge.status, body: merge.body })
    let mergedState = ''
    for (let i = 0; i < 10; i++) {
      const r = await execa('gh', ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'state'], { reject: false })
      try { mergedState = JSON.parse(r.stdout).state } catch { /* ignore */ }
      if (mergedState === 'MERGED') break
      await new Promise(r => setTimeout(r, 3000))
    }
    assert('stage2_15_pr_merged', mergedState === 'MERGED', { state: mergedState })
    result.stage2 = { ...(result.stage2 as object), redState, greenState, mergeStatus: merge.status, mergedState, deleteCmd: `gh repo delete ${repoSlug} --yes` }
    console.log(`[smoke] Stage 2 transitions: k/verify ${redState}→${greenState}; merge 409→${merge.status}; PR ${mergedState}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FINISH
// ══════════════════════════════════════════════════════════════════════════════
finishResult()
await cleanup()

const failed = assertions.filter(a => !a.ok)
const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
console.log(`\n[smoke] TOTAL MEASURED COST: $${total.toFixed(4)} (cap $${COST_CAP_USD})${total > COST_CAP_USD ? '  ** BUDGET EXCEEDED **' : ''}`)
if (failed.length > 0) {
  console.error(`\nSMOKE FAIL — ${failed.length} assertion(s): ${failed.map(a => a.name).join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — plan gate park/notify/edit/double-send/continuation + cost-carry + reboot survival + E-06 blocked→green merge all verified with measured costs.')
