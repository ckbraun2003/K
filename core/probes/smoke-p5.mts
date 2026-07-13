/**
 * P5 PHASE SMOKE (Autonomy) — the cron/event-driven autonomy stack driven THROUGH the
 * REAL core, IN-PROCESS (these features are not HTTP-triggerable), against an ISOLATED
 * stack (fresh K_DATA_DIR — NEVER the dev data/k.db, NEVER the host ~/.claude).
 *
 * Because db.ts reads K_DATA_DIR at MODULE LOAD (`new Database(path.join(DATA_DIR,…))`),
 * the temp dir is assigned to process.env BEFORE any core import — every core module is
 * pulled in via dynamic `await import()` AFTER that assignment.
 *
 * The five scenarios (all against the isolated stack; assertions on DB state). Real legs
 * are HAIKU dispatches (measured cost_usd only, NEVER estimated); a $5 hard abort cap
 * guards runaway (expected total well under $1):
 *
 *   1. Budget cap PARKS a real dispatch, then proceeds after raise. No cap → one real
 *      haiku dispatch (spend S>0). Set orgDailyBudgetUsd < S → budgetGate({}) is
 *      {allowed:false,scope:'org'}, a would-be autonomous startAgentRun throws
 *      BudgetCapError (no row, no cost), budgetStatus().org.state==='capped'. Raise to
 *      null → the same dispatch proceeds ('done').
 *   2. Proposal → approve → governed backlog auto-pull dispatches EXACTLY ONE run.
 *      persistProposals(1) → 1 blocked+org row; approveProposal → 'open'; drainBacklog()
 *      CAS-claims it ('in_progress' + run_id) and dispatches exactly ONE real run; a
 *      second drainBacklog() with no open items → 0.
 *   3. Induced transient failure retries (governed) then the retry runs. Seed a failed
 *      org run (runs 'error' + agent_runs owner + events 'error' text 'ECONNRESET');
 *      onRunTerminalForHeal → 'retried', a NEW run with retry_of=<orig> + retry_count=1,
 *      the FALLBACK model + the ORIGINAL cwd (SEAMS M1), a run_retried broadcast; poll
 *      the retry to terminal.
 *   4. ≥2 same-signature failures → EXACTLY one lesson, deduped (ZERO cost).
 *      proposeLessons() → 1; again → 0; exactly one agent_memory status='pending'.
 *   5. CHIEF_WAKE user-toggle governs a real wake. enabled:false → wakeChief no-ops
 *      (reason 'disabled', no Chief agent_runs row); enabled:true → a real Chief wake
 *      row + real dispatch (poll to terminal); enabled:false again → no-op. The
 *      env-deprecation: with CHIEF_WAKE=1 but autonomy OFF, the gate (autonomySettings
 *      .enabled, which chiefWakeEnabled() reads) is still false — the env is ignored.
 *
 * Every dispatch pins MODEL (haiku); the global Claude default is ALSO pinned to haiku so
 * the profile-default legs (backlog pull, chief wake) stay cheap. LIVE — never runs in CI.
 * Run from core/:  pnpm exec tsx probes/smoke-p5.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORE_DIR = path.join(__dirname, '..')       // core/
const REPO_ROOT = path.join(__dirname, '../..')   // k/
const OUT_DIR = path.join(__dirname, 'out', 'p5') // GITIGNORED (core/probes/out/)
const MODEL = 'claude-haiku-4-5-20251001'
const COST_CAP_USD = 5                             // hard safety abort (ceiling; expected << $1)
const RUN_PROMPT = 'reply with the single word: ready'
const TERMINAL = new Set(['done', 'error', 'killed', 'interrupted'])

// ── isolated data dir — MUST be set BEFORE any core import (db.ts reads it at load) ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p5-data-'))
process.env.K_DATA_DIR = dataDir
// Defensive: none of the imported modules auto-start pollers on import (start* are only
// called from index.ts), but pin the disables anyway so a future import side-effect can't
// spin a cron tick against this isolated stack.
process.env.PROPOSAL_COLLECTORS = '0'
process.env.BACKLOG_RELAY = '0'
process.env.LESSON_PROPOSALS = '0'
process.env.GRAPH_AUTO_REINDEX = '0' // no post-run gitnexus reindex against this isolated stack
fs.mkdirSync(OUT_DIR, { recursive: true })
console.log(`[smoke] isolated data dir: ${dataDir}`)

// ── dynamic core imports (AFTER K_DATA_DIR is assigned) ─────────────────────────
const { seedProfiles } = await import('../src/profiles.js')
const { setAutonomySettings, autonomySettings, setClaudeDefaultModel } = await import('../src/config-store.js')
const { budgetGate, budgetStatus, BudgetCapError } = await import('../src/budget-governor.js')
const { persistProposals } = await import('../src/proposal-collectors.js')
const { drainBacklog } = await import('../src/backlog-relay.js')
const { onRunTerminalForHeal } = await import('../src/self-heal.js')
const { proposeLessons } = await import('../src/lesson-proposals.js')
const { wakeChief, resetChiefWakeDebounce } = await import('../src/chief-wake.js')
const { startAgentRun } = await import('../src/agent-runs.js')
const { kill: killRun } = await import('../src/supervisor.js')
const { runsDb, proposalsDb, agentRunsDb, budgetDb, db } = await import('../src/db.js')
const { eventBus } = await import('../src/events.js')

// ── result accounting ───────────────────────────────────────────────────────────
type RunRecord = { label: string; id: string; status: string; costUsd: number }
const assertions: { name: string; ok: boolean; hard: boolean; detail?: unknown }[] = []
const findings: string[] = []
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  model: MODEL,
  dataDir,
  runs: [] as RunRecord[],
  totalCostUsd: 0,
  budgetCapUsd: COST_CAP_USD,
  budgetExceeded: false,
  assertions,
  findings,
  scenario1_budget: {} as Record<string, unknown>,
  scenario2_backlog: {} as Record<string, unknown>,
  scenario3_selfheal: {} as Record<string, unknown>,
  scenario4_lessons: {} as Record<string, unknown>,
  scenario5_chiefwake: {} as Record<string, unknown>,
  info: {} as Record<string, unknown>,
}
const runs = result.runs as RunRecord[]
const myRunIds: string[] = []
const broadcasts: any[] = []
eventBus.onBroadcast((m: any) => { broadcasts.push(m) })

/** hard assertions gate the exit code; soft ones are recorded + surfaced but never flip PASS→FAIL. */
function assert(name: string, ok: boolean, hard: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, hard, detail })
  console.log(`[smoke] ${ok ? 'OK  ' : 'FAIL'} ${hard ? '' : '(soft) '}${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  return ok
}

// ── scratch git repo (a real git dir for run worktrees) ─────────────────────────
const GIT_ID = ['-c', 'user.name=p5-smoke', '-c', 'user.email=p5-smoke@k.local']
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-p5-scratch-'))
await execa('git', ['-C', scratchDir, 'init', '-b', 'main'], { reject: true })
fs.writeFileSync(path.join(scratchDir, 'README.md'), '# p5 smoke scratch\n')
await execa('git', ['-C', scratchDir, ...GIT_ID, 'add', '-A'], { reject: true })
await execa('git', ['-C', scratchDir, ...GIT_ID, 'commit', '-m', 'seed'], { reject: true })
console.log(`[smoke] scratch repo: ${scratchDir}`)

function finishResult(): void {
  result.finishedAt = new Date().toISOString()
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  result.totalCostUsd = total
  result.budgetExceeded = total > COST_CAP_USD
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-result.json'), JSON.stringify(result, null, 2))
}

async function cleanup(): Promise<void> {
  // Kill any run still active (best-effort; kill() returns false for already-terminal ids).
  for (const id of myRunIds) { try { killRun(id) } catch { /* gone */ } }
  await new Promise(r => setTimeout(r, 1500))
  try { db.close() } catch { /* already closed */ }
  // Targeted worktree-leftover sweep for THIS probe's run ids only (never others').
  for (const id of myRunIds) {
    const wt = path.join(REPO_ROOT, '.worktrees', id)
    for (const repo of [REPO_ROOT, scratchDir]) {
      await execa('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { reject: false })
    }
    if (fs.existsSync(wt)) { try { fs.rmSync(wt, { recursive: true, force: true }) } catch { /* best-effort */ } }
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

async function fail(msg: string): Promise<never> {
  console.error(`\nSMOKE FAIL: ${msg}`)
  result.info = { ...(result.info as object), failure: msg }
  finishResult()
  await cleanup()
  process.exit(1)
}

// ── run polling (reads the SAME in-process DB the supervisor writes to) ──────────
function getRunRow(id: string): any { return runsDb.getRun.get(id) as any }

async function pollRun(id: string, label: string, tries = 150): Promise<any> {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 4000))
    const row = getRunRow(id)
    if (row && TERMINAL.has(String(row.status))) return row
  }
  try { killRun(id) } catch { /* gone */ }
  findings.push(`run ${label} (${id}) did not reach terminal within ${tries * 4}s — killed; treated as environmental`)
  return getRunRow(id) ?? { id, status: 'timeout', cost_usd: 0 }
}

async function recordRun(label: string, row: any): Promise<void> {
  const rec: RunRecord = { label, id: String(row.id), status: String(row.status), costUsd: Number(row.cost_usd ?? 0) }
  runs.push(rec)
  const total = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
  console.log(`[smoke] run ${label} ${row.id}: ${row.status}, MEASURED $${rec.costUsd.toFixed(4)} (total $${total.toFixed(4)})`)
  if (total > COST_CAP_USD) await fail(`accumulated MEASURED cost $${total.toFixed(4)} exceeds the hard $${COST_CAP_USD} cap — aborting`)
}

/** Dispatch a REAL run through startAgentRun, poll to terminal, record measured cost. */
async function dispatchAndWait(profileId: string, opts: any, label: string): Promise<any> {
  const { runId } = await startAgentRun(profileId, opts)
  myRunIds.push(runId)
  console.log(`[smoke] ${label} dispatched: run ${runId}`)
  const row = await pollRun(runId, label)
  await recordRun(label, row)
  return { runId, row }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT — migrations ran at db import; seed the roster + pin the Claude default to haiku
// ══════════════════════════════════════════════════════════════════════════════
seedProfiles()
setClaudeDefaultModel(MODEL) // so profile-default dispatches (backlog pull, chief wake) stay haiku
// Baseline: default autonomy (all OFF, no cap).
setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — budget cap PARKS a real dispatch, then proceeds after raise
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n[smoke] === Scenario 1: budget park / raise ===')
// (a) No cap — one real dispatch establishes measured spend S. This is ALSO the live-dispatch
//     CANARY: if the CLI is not authed the run ends non-'done' and we STOP (BLOCKER-for-smoke).
const s1a = await dispatchAndWait('default-orchestrator',
  { trigger: 'schedule', goal: RUN_PROMPT, model: MODEL, cwd: scratchDir }, 'S1-precap')
if (s1a.row.status !== 'done') {
  result.scenario1_budget = { canaryStatus: s1a.row.status, canaryCost: Number(s1a.row.cost_usd ?? 0) }
  result.info = {
    ...(result.info as object),
    blocker: `First real dispatch ended '${s1a.row.status}' (not 'done') at zero/near-zero cost — live Claude dispatch appears UNAVAILABLE in this environment (CLI not authed / errored immediately). Stopping WITHOUT burning further dispatches. This is a BLOCKER-FOR-SMOKE (environment), not a P5 code bug.`,
  }
  assert('s1_live_dispatch_available', false, true, { status: s1a.row.status })
  finishResult()
  await cleanup()
  console.error('\nSMOKE BLOCKED — live dispatch unavailable; see result.info.blocker')
  process.exit(1)
}
assert('s1_live_dispatch_available', true, true, { status: s1a.row.status, costUsd: Number(s1a.row.cost_usd ?? 0) })

const since = Date.now() - 24 * 3_600_000
const S = Number((budgetDb.orgSpendSince.get(since) as { spend: number }).spend)
const cap = S / 2 // strictly < S and > 0 (S measured > 0)
assert('s1_measured_spend_positive', S > 0, true, { orgSpendUsd: S })

// (b) Set org cap < S → gate refuses, status capped.
setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: cap, budgetWarnPct: 0.8 })
const gate = budgetGate({})
assert('s1_gate_blocks_org', gate.allowed === false && (gate as any).scope === 'org', true,
  { allowed: gate.allowed, scope: (gate as any).scope, capUsd: (gate as any).capUsd, spentUsd: (gate as any).spentUsd })
const status = budgetStatus()
assert('s1_budget_status_capped', status.org.state === 'capped', true,
  { state: status.org.state, capUsd: status.org.capUsd, spentUsd: status.org.spentUsd })

// A would-be autonomous dispatch (gated trigger) must throw BudgetCapError — thrown BEFORE
// the tracking-row insert, so NO agent_runs row + NO cost. Count agent_runs before/after.
const arBefore = (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number }).n
let capError: any = null
try {
  await startAgentRun('default-orchestrator', { trigger: 'schedule', goal: RUN_PROMPT, model: MODEL, cwd: scratchDir })
} catch (e) { capError = e }
const arAfter = (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number }).n
assert('s1_startAgentRun_throws_BudgetCapError',
  !!capError && (capError instanceof BudgetCapError || String(capError?.name) === 'BudgetCapError') && arAfter === arBefore, true,
  { errorName: capError?.name, message: String(capError?.message ?? ''), agentRunsDelta: arAfter - arBefore })

// (c) Raise (null) → the same dispatch now proceeds ('done').
setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })
const s1c = await dispatchAndWait('default-orchestrator',
  { trigger: 'schedule', goal: RUN_PROMPT, model: MODEL, cwd: scratchDir }, 'S1-postraise')
assert('s1_dispatch_proceeds_after_raise', s1c.row.status === 'done', true, { status: s1c.row.status })
result.scenario1_budget = {
  spendS: S, cap, gate, orgState: status.org.state,
  capError: capError ? { name: capError.name, message: String(capError.message) } : null,
  precapRun: { id: s1a.runId, status: s1a.row.status, cost: Number(s1a.row.cost_usd ?? 0) },
  postraiseRun: { id: s1c.runId, status: s1c.row.status, cost: Number(s1c.row.cost_usd ?? 0) },
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — proposal → approve → governed backlog auto-pull dispatches EXACTLY ONE
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n[smoke] === Scenario 2: proposal → approve → backlog auto-pull ===')
setAutonomySettings({ enabled: true, proposals: true, backlogAutoPull: true, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })

const inserted = persistProposals([{ source: 'ci_failed', sourceKey: 'ci_failed:smoke', title: 'CI failing on smoke', body: null, projectId: null }])
const blockedRows = db.prepare(
  `SELECT * FROM work_items WHERE scope='org' AND status='blocked' AND source='ci_failed' AND source_key='ci_failed:smoke'`).all() as any[]
assert('s2_proposal_persisted', inserted === 1 && blockedRows.length === 1, true,
  { inserted, blockedCount: blockedRows.length })
const proposalRow = proposalsDb.getProposalBySourceKey.get('ci_failed:smoke') as any
const proposalId = String(proposalRow?.id)

// Approve: blocked → open.
proposalsDb.approveProposal.run({ id: proposalId, now: Date.now() })
const afterApprove = proposalsDb.getProposalBySourceKey.get('ci_failed:smoke') as any
assert('s2_proposal_approved_open', afterApprove?.status === 'open', true, { status: afterApprove?.status })

// drainBacklog → CAS-claim ('in_progress' + run_id) and dispatch exactly ONE real run.
const dispatched1 = await drainBacklog()
const claimed = proposalsDb.getProposalBySourceKey.get('ci_failed:smoke') as any
assert('s2_backlog_dispatched_one', dispatched1 === 1, true, { dispatched: dispatched1 })
assert('s2_item_claimed_in_progress', claimed?.status === 'in_progress' && !!claimed?.run_id, true,
  { status: claimed?.status, runId: claimed?.run_id })

let s2run: any = { status: 'no-run', cost_usd: 0 }
if (claimed?.run_id) {
  myRunIds.push(String(claimed.run_id))
  s2run = await pollRun(String(claimed.run_id), 'S2-backlog-pull')
  await recordRun('S2-backlog-pull', s2run)
  assert('s2_pulled_run_terminal', TERMINAL.has(String(s2run.status)), true, { status: s2run.status })
}

// A second drain with no open items → 0 new dispatches.
const dispatched2 = await drainBacklog()
assert('s2_second_drain_zero', dispatched2 === 0, true, { dispatched: dispatched2 })
result.scenario2_backlog = {
  inserted, proposalId, approvedStatus: afterApprove?.status,
  firstDrain: dispatched1, claimedStatus: claimed?.status, claimedRunId: claimed?.run_id,
  pulledRunStatus: s2run.status, pulledRunCost: Number(s2run.cost_usd ?? 0), secondDrain: dispatched2,
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — induced transient failure retries (governed), then the retry runs
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n[smoke] === Scenario 3: self-heal transient retry ===')
setAutonomySettings({ enabled: true, proposals: false, backlogAutoPull: false, selfHeal: true, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })

// Seed a FAILED org run: runs 'error' (model haiku, retry_count 0, REAL cwd=scratchDir) +
// its agent_runs owner + a type='error' event carrying a transient (ECONNRESET) diagnosis.
const origRunId = `sh-${randomUUID()}`
const nowSeed = Date.now()
db.prepare(`INSERT INTO runs (id, prompt, cwd, worktree, status, provider, model, retry_count, created_at)
            VALUES (?, ?, ?, NULL, 'error', 'claude', ?, 0, ?)`).run(origRunId, RUN_PROMPT, scratchDir, MODEL, nowSeed)
db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at)
            VALUES (?, 'default-orchestrator', ?, 'delegation', 'g', 'failed', ?)`).run(randomUUID(), origRunId, nowSeed)
db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, text)
            VALUES (?, ?, 1, 'error', ?, 'ECONNRESET: socket hang up')`).run(randomUUID(), origRunId, nowSeed)

const healOutcome = await onRunTerminalForHeal({ id: origRunId, status: 'error' } as any)
assert('s3_heal_retried', healOutcome === 'retried', true, { outcome: healOutcome })

const retryRow = db.prepare(`SELECT * FROM runs WHERE retry_of = ?`).get(origRunId) as any
const retriedBroadcast = broadcasts.find(b => b?.type === 'run_retried' && b?.originalRunId === origRunId)
assert('s3_retry_lineage', !!retryRow && retryRow.retry_of === origRunId && Number(retryRow.retry_count) === 1, true,
  { retryId: retryRow?.id, retryOf: retryRow?.retry_of, retryCount: retryRow?.retry_count })
assert('s3_retry_fallback_model_and_orig_cwd',
  !!retryRow && retryRow.model === MODEL && retryRow.cwd === scratchDir, true,
  { retryModel: retryRow?.model, expectedModel: MODEL, retryCwd: retryRow?.cwd, origCwd: scratchDir })
assert('s3_run_retried_broadcast', !!retriedBroadcast && retriedBroadcast.retryRunId === retryRow?.id, true,
  { broadcast: retriedBroadcast ?? null })

let s3retry: any = { status: 'no-run', cost_usd: 0 }
if (retryRow?.id) {
  myRunIds.push(String(retryRow.id))
  s3retry = await pollRun(String(retryRow.id), 'S3-retry')
  await recordRun('S3-retry', s3retry)
  assert('s3_retry_terminal', TERMINAL.has(String(s3retry.status)), true, { status: s3retry.status })
}
result.scenario3_selfheal = {
  origRunId, healOutcome,
  retryId: retryRow?.id, retryOf: retryRow?.retry_of, retryCount: retryRow?.retry_count,
  retryModel: retryRow?.model, retryCwd: retryRow?.cwd,
  retriedBroadcast: retriedBroadcast ?? null,
  retryStatus: s3retry.status, retryCost: Number(s3retry.cost_usd ?? 0),
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — ≥2 same-signature failures → EXACTLY one lesson, deduped (ZERO cost)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n[smoke] === Scenario 4: repeated-failure → gated lesson (zero cost) ===')
setAutonomySettings({ enabled: true, proposals: true, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })

const SAME_REASON = 'verify command `pnpm build` exited 1: TS2345 assignment mismatch'
const now4 = Date.now()
for (let i = 0; i < 2; i++) {
  const rid = `lp-${randomUUID()}`
  db.prepare(`INSERT INTO runs (id, prompt, cwd, worktree, status, created_at) VALUES (?, 'p', '.', '.', 'error', ?)`).run(rid, now4)
  db.prepare(`INSERT INTO verify_results (run_id, status, reason, commands, scope, started_at, completed_at)
              VALUES (?, 'fail', ?, '[]', 'project', ?, ?)`).run(rid, SAME_REASON, now4, now4)
}
const lessons1 = proposeLessons()
const lessons2 = proposeLessons()
const pendingLessons = db.prepare(`SELECT * FROM agent_memory WHERE status='pending'`).all() as any[]
assert('s4_first_pass_one_lesson', lessons1 === 1, true, { inserted: lessons1 })
assert('s4_second_pass_deduped_zero', lessons2 === 0, true, { inserted: lessons2 })
assert('s4_exactly_one_pending_lesson', pendingLessons.length === 1, true, { pending: pendingLessons.length })
result.scenario4_lessons = {
  firstPass: lessons1, secondPass: lessons2, pendingCount: pendingLessons.length,
  lessonPreview: String(pendingLessons[0]?.lesson ?? '').slice(0, 160),
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — CHIEF_WAKE user-toggle governs a real wake (+ env-deprecation)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n[smoke] === Scenario 5: chief-wake toggle governs a real wake ===')
const chiefCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE profile_id='chief'`).get() as { n: number }).n

// (a) autonomy OFF → wakeChief no-ops (reason 'disabled'), NO chief agent_runs row.
setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })
resetChiefWakeDebounce()
const chiefBeforeOff = chiefCount()
const wakeOff = await wakeChief('schedule', { goal: RUN_PROMPT })
const chiefAfterOff = chiefCount()
assert('s5_wake_disabled_noop', wakeOff.woke === false && (wakeOff as any).reason === 'disabled' && chiefAfterOff === chiefBeforeOff, true,
  { outcome: wakeOff, chiefRowsDelta: chiefAfterOff - chiefBeforeOff })

// (b) autonomy ON → a real Chief wake row + a real dispatch (poll to terminal).
setAutonomySettings({ enabled: true, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })
resetChiefWakeDebounce()
const wakeOn = await wakeChief('schedule', { goal: RUN_PROMPT })
assert('s5_wake_enabled_dispatched', wakeOn.woke === true && !!(wakeOn as any).runId, true, { outcome: wakeOn })
let s5run: any = { status: 'no-run', cost_usd: 0 }
let chiefWakeRow: any = null
if (wakeOn.woke) {
  const runId = (wakeOn as any).runId
  myRunIds.push(String(runId))
  chiefWakeRow = db.prepare(`SELECT * FROM agent_runs WHERE profile_id='chief' AND run_id=? AND trigger='schedule'`).get(runId) as any
  assert('s5_chief_wake_ledger_row', !!chiefWakeRow, true, { agentRunId: chiefWakeRow?.id, trigger: chiefWakeRow?.trigger })
  s5run = await pollRun(String(runId), 'S5-chief-wake')
  await recordRun('S5-chief-wake', s5run)
  assert('s5_chief_run_terminal', TERMINAL.has(String(s5run.status)), true, { status: s5run.status })
}

// (c) autonomy OFF again + CHIEF_WAKE env=1 → still no-op (the persisted setting, NOT the env,
//     governs — chiefWakeEnabled() reads autonomySettings().enabled). Prove the env is ignored.
process.env.CHIEF_WAKE = '1'
setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 })
resetChiefWakeDebounce()
const chiefBeforeEnv = chiefCount()
const wakeEnv = await wakeChief('schedule', { goal: RUN_PROMPT })
const chiefAfterEnv = chiefCount()
const persistedEnabled = autonomySettings().enabled
assert('s5_env_deprecated_persisted_governs',
  wakeEnv.woke === false && (wakeEnv as any).reason === 'disabled' && persistedEnabled === false && chiefAfterEnv === chiefBeforeEnv, true,
  { chiefWakeEnvSet: process.env.CHIEF_WAKE, persistedEnabled, outcome: wakeEnv, chiefRowsDelta: chiefAfterEnv - chiefBeforeEnv })
result.scenario5_chiefwake = {
  disabledOutcome: wakeOff, enabledOutcome: wakeOn,
  chiefWakeRowId: chiefWakeRow?.id, chiefRunStatus: s5run.status, chiefRunCost: Number(s5run.cost_usd ?? 0),
  envIgnoredOutcome: wakeEnv, persistedEnabledUnderEnv: persistedEnabled,
}

// ══════════════════════════════════════════════════════════════════════════════
// FINISH
// ══════════════════════════════════════════════════════════════════════════════
finishResult()
const measuredTotal = runs.reduce((s, r) => s + (r.costUsd || 0), 0)
await cleanup()

const hardFailed = assertions.filter(a => a.hard && !a.ok)
const softFailed = assertions.filter(a => !a.hard && !a.ok)
console.log(`\n[smoke] TOTAL MEASURED COST: $${measuredTotal.toFixed(4)} (cap $${COST_CAP_USD})${measuredTotal > COST_CAP_USD ? '  ** BUDGET EXCEEDED **' : ''} across ${runs.length} real dispatches`)
if (findings.length > 0) { console.log(`[smoke] ${findings.length} finding(s):`); for (const f of findings) console.log(`[smoke]   FINDING: ${f}`) }
if (softFailed.length > 0) console.log(`[smoke] ${softFailed.length} soft (non-gating): ${softFailed.map(a => a.name).join(', ')}`)
if (hardFailed.length > 0) {
  console.error(`\nSMOKE FAIL — ${hardFailed.length} hard assertion(s): ${hardFailed.map(a => a.name).join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE PASS — budget park/raise + backlog auto-pull (exactly one) + self-heal transient retry (fallback model + orig cwd) + repeated-failure gated lesson (dedup) + chief-wake toggle (env-deprecated) all verified with measured costs.')
