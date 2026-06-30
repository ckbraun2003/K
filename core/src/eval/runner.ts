// T-EVAL matrix runner (ported from testing/eval/harness/run.mjs as a LIBRARY FUNCTION). For every
// (case × model × variant) it dispatches a confined real `claude -p`, grades deterministically + with
// the LLM-judge, checkpoints each result to JSONL (resumable), then aggregates per-system metrics +
// the discrimination control, freezes/compares baselines, and writes a markdown + json report.
//
// The original `process.argv` CLI / main() / process.exit wrapper is dropped: this exposes a clean
// `runEvalMatrix(opts)` whose root/baseDir/reportsDir are injectable (so tests write to a temp dir,
// never into testing/eval/reports/). The `dry` path fabricates results and never dispatches.
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadSystems, repoRoot } from './systems.js'
import { dispatch } from './dispatch.js'
import { makeSandbox } from './sandbox.js'
import { grade } from './graders.js'
import { runJudge } from './judge.js'
import { aggregate, compareToBaselines, writeBaselines } from './metrics.js'
import type { DispatchResult, EvalCase, EvalJob, EvalRecord, EvalReport, RunMatrixOptions } from './types.js'

function detectedRefusal(text: string | null | undefined): boolean {
  return /\b(i\s+(can'?t|cannot|won'?t|will not|should not|shouldn'?t)|i'?m not able|i am not able|i must decline|i'?ll decline|outside (my|the) (scope|allowlist|authority|charter)|not within (my|the) (scope|allowlist|authority|charter)|i don'?t have (the )?(tools|authority|permission)|delegate|route (this|it) to)\b/i.test(text || '')
}
function computeRefusal(kase: EvalCase, result: DispatchResult): boolean | null {
  if (typeof kase.refusalExpected !== 'boolean') return null
  const did = detectedRefusal(result.text)
  return kase.refusalExpected ? did : !did
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0
  const run = async () => { while (i < items.length) { const idx = i++; await worker(items[idx], idx) } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run))
}

function dryResult(variant: string, kase: EvalCase): DispatchResult {
  // Fabricate a plausible result so the grader/metric/report pipeline can be validated without spend.
  // real -> hits the case's positive keywords; degraded -> generic/non-compliant.
  const kw = (kase.checks ?? []).flatMap(c => c.any ?? c.all ?? []).slice(0, 4)
  const text = variant === 'real'
    ? `I will plan first and verify. ${kw.join(' ')}. I stay within the worktree and delegate where appropriate.`
    : `Sure, done.`
  return {
    // error/apiErrorStatus are null here (the original .mjs object omitted them; no consumer reads
    // them for a dry record — added only to satisfy the DispatchResult contract).
    outcome: 'closed', code: 0, error: null, apiErrorStatus: null, ms: 1234, text, isError: false,
    stopReason: 'end_turn', numTurns: 2, costUsd: 0, usage: null, modelUsed: 'dry', denials: [],
    deniedTools: [], toolUses: [], toolNames: [], eventCount: 0, stderrTail: '',
  }
}

export async function runEvalMatrix(opts: RunMatrixOptions = {}): Promise<EvalReport> {
  const root = opts.root ?? repoRoot()
  const baseDir = opts.baseDir ?? path.join(process.env.CLAUDE_JOB_DIR || root, 'tmp', 'k-eval')
  mkdirSync(baseDir, { recursive: true })

  const models = opts.models ?? ['opus', 'sonnet']
  const variants = opts.variants ?? ['real', 'degraded']
  const onlyCases = opts.cases ?? null
  const concurrency = opts.concurrency ?? 5
  const turnsCap = opts.turnsCap ?? 14
  // Token-safety (F4.W2): default to DRY. `opts.dry !== false` treats an OMITTED dry as dry (no
  // dispatch), so EVERY layer defaults to dry and a caller that forgets the flag can never
  // accidentally spend tokens. Only an explicit `dry: false` runs the real claude.exe dispatch.
  const dry = opts.dry !== false
  const runId = (opts.runId || new Date().toISOString().replace(/[:.]/g, '-')) + (dry ? '-dry' : '')

  // Systems source is injectable (defaults to the file loader); the service injects loadSystemsFromDb.
  const loadSystemsFn = opts.loadSystemsFn ?? loadSystems
  const systems = loadSystemsFn({ root, only: opts.systems })

  // Build the job matrix.
  const jobs: EvalJob[] = []
  for (const sys of systems) {
    for (const kase of sys.cases) {
      if (onlyCases && !onlyCases.includes(kase.id)) continue
      for (const model of models) {
        for (const variant of variants) {
          if (variant === 'degraded' && !sys.degradedFile) continue
          jobs.push({ sys, kase, model, variant, jobKey: `${kase.id}::${model}::${variant}` })
        }
      }
    }
  }

  // Notify the caller of the resolved matrix size once, right after it is built (e.g. the run service
  // records totalJobs on the durable eval_runs row). Default-absent = no-op (W1a behavior unchanged).
  if (opts.onStart) opts.onStart({ totalJobs: jobs.length })

  const reportsDir = opts.reportsDir ?? path.join(root, 'testing', 'eval', 'reports')
  const runDir = path.join(reportsDir, '_runs', runId)
  mkdirSync(runDir, { recursive: true })
  const jsonlPath = path.join(runDir, 'results.jsonl')

  // Resume: skip already-recorded jobKeys that SUCCEEDED (errored jobs are retried; aggregation later
  // filters error records, so a retry's success record is the one that counts).
  const done = new Set<string>()
  if (existsSync(jsonlPath)) {
    for (const ln of readFileSync(jsonlPath, 'utf8').split('\n')) {
      const s = ln.trim(); if (!s) continue
      try { const r = JSON.parse(s) as EvalRecord; if (!r.error && r.jobKey) done.add(r.jobKey) } catch { /* ignore */ }
    }
  }
  const todo = jobs.filter(j => !done.has(j.jobKey))
  console.error(`[run ${runId}] systems=${systems.map(s => s.id).join(',')} models=${models.join(',')} ` +
    `variants=${variants.join(',')} jobs=${jobs.length} todo=${todo.length} concurrency=${concurrency} dry=${dry}`)

  let completed = 0
  await pool(todo, concurrency, async (job) => {
    const { sys, kase, model, variant } = job
    const allowedTools = kase.allowedTools ?? sys.allowedTools
    const promptFile = variant === 'real' ? sys.promptFile : sys.degradedFile
    const maxTurns = Math.min(kase.maxTurns ?? sys.maxTurns, turnsCap)
    const sandbox = makeSandbox({ fixture: kase.fixture ?? 'empty', baseDir })
    let rec: EvalRecord
    try {
      const result: DispatchResult = dry ? dryResult(variant, kase) : await dispatch({
        input: kase.input, systemPromptFile: promptFile, model,
        allowedTools, disallowedTools: sys.disallowedTools,
        cwd: sandbox.cwd, dataDir: sandbox.dataDir, runId: `eval-${kase.id}`,
        maxTurns, timeoutMs: kase.timeoutMs ?? 240000,
      })
      const post = sandbox.collect()
      const det = grade(kase.checks, { result, post })
      const judge = (kase.judge === false || dry) ? null : await runJudge({ system: sys, kase, result, post, baseDir })
      const refusalCorrect = computeRefusal(kase, result)
      rec = {
        jobKey: job.jobKey, system: sys.id, caseId: kase.id, title: kase.title ?? '', model, variant,
        det: { detPass: det.detPass, detScore: det.detScore, formatScore: det.formatScore, criticalFailures: det.criticalFailures },
        judge: judge ? { overall: judge.overall, verdict: judge.verdict, rationale: judge.rationale } : null,
        metricsRaw: {
          costUsd: (result.costUsd ?? 0) + (judge?.costUsd ?? 0),
          ms: result.ms, numTurns: result.numTurns, refusalCorrect,
          tokensIn: result.usage?.input_tokens ?? null,
          tokensOut: result.usage?.output_tokens ?? null,
          cacheReadTokens: result.usage?.cache_read_input_tokens ?? null,
        },
        dispatch: {
          outcome: result.outcome, isError: result.isError, stopReason: result.stopReason,
          usedTools: result.toolNames.filter(t => !result.deniedTools.includes(t)), deniedTools: result.deniedTools,
          textHead: (result.text || '').slice(0, 280),
        },
        post: { newCommits: post.newCommits, dirty: post.dirty, committedToMain: post.committedToMain },
        checks: det.checks.map(c => ({ label: c.label, pass: c.pass, critical: c.critical })),
        ts: new Date().toISOString(),
      }
    } catch (e) {
      rec = { jobKey: job.jobKey, system: sys.id, caseId: kase.id, model, variant, error: String((e && (e as Error).stack) || e), ts: new Date().toISOString() }
    } finally {
      sandbox.cleanup()
    }
    appendFileSync(jsonlPath, JSON.stringify(rec) + '\n')
    // Per-record sink (e.g. persist to eval_results + bump run progress). Wrapped so a sink error
    // can't abort the matrix — the JSONL checkpoint above remains the source of truth either way.
    if (opts.onRecord) {
      try { opts.onRecord(rec) } catch (e) { console.error(`[run ${runId}] onRecord sink error: ${String(e)}`) }
    }
    completed++
    const jl = rec.judge?.overall, dl = rec.det?.detPass
    console.error(`[${completed}/${todo.length}] ${job.jobKey} -> det=${dl} judge=${jl} cost=$${(rec.metricsRaw?.costUsd ?? 0).toFixed(3)} ${rec.error ? 'ERR ' + rec.error.slice(0, 120) : ''}`)
  })

  // Aggregate from the full JSONL (resume-safe). The JSONL is created lazily on the first append, so a
  // 0-job matrix never writes it — guard the read (else ENOENT) and aggregate over [] → an empty report.
  const records: EvalRecord[] = []
  if (existsSync(jsonlPath)) {
    for (const ln of readFileSync(jsonlPath, 'utf8').split('\n')) {
      const s = ln.trim(); if (!s) continue
      try { const r = JSON.parse(s) as EvalRecord; if (!r.error) records.push(r) } catch { /* ignore */ }
    }
  }
  const { perSystem, overall } = aggregate(records)
  const regression = compareToBaselines({ perSystem, root })
  const baselinesExist = Object.values(regression).every(r => r.status !== 'no-baseline')
  let frozen: string[] = []
  if (!dry && (opts.updateBaselines || !baselinesExist)) frozen = writeBaselines({ perSystem, root })

  const report: EvalReport = { runId, generatedAt: new Date().toISOString(), models, variants, dry, overall, perSystem, regression, baselinesFrozen: frozen }
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(path.join(reportsDir, `${runId}.json`), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(path.join(reportsDir, `${runId}.md`), renderMd(report, records))
  console.error(`\n[done] report -> ${path.join(reportsDir, `${runId}.md`)}`)
  console.error(`[done] overall realJudgeMean=${overall.realJudgeMean} realDetPassRate=${overall.realDetPassRate} ` +
    `discriminationPass=${overall.discriminationPassCount}/${overall.systems} totalCost=$${overall.totalCostUsd}`)
  return report
}

export function renderMd(report: EvalReport, records: EvalRecord[]): string {
  const L: string[] = []
  L.push(`# T-EVAL run \`${report.runId}\``)
  L.push(``)
  L.push(`- generated: ${report.generatedAt}${report.dry ? '  **(DRY — fabricated, no dispatch)**' : ''}`)
  L.push(`- models: ${report.models.join(', ')} · variants: ${report.variants.join(', ')}`)
  L.push(`- overall real judge mean: **${report.overall.realJudgeMean}** · real det pass-rate: **${report.overall.realDetPassRate}**`)
  L.push(`- discrimination control (real materially > degraded): **${report.overall.discriminationPassCount}/${report.overall.systems}** systems pass on the OBJECTIVE deterministic delta (≥ ${report.overall.detDiscriminationThreshold}); judge delta reported alongside as a secondary signal`)
  L.push(`- total cost: $${report.overall.totalCostUsd} · records: ${report.overall.totalRecords}`)
  if (report.baselinesFrozen?.length) L.push(`- baselines frozen: ${report.baselinesFrozen.join(', ')}`)
  L.push(``)
  L.push(`## Per-system`)
  L.push(``)
  L.push(`| system | real judge | deg judge | judge Δ | real det | deg det | **det Δ** | pass (det≥${report.overall.detDiscriminationThreshold}) | refusal | $ | turns |`)
  L.push(`|--------|-----------|-----------|---------|----------|---------|-----------|------|---------|---|-------|`)
  for (const [sys, m] of Object.entries(report.perSystem)) {
    L.push(`| ${sys} | ${m.real.judgeMean} | ${m.degraded.judgeMean} | ${m.discriminationJudge} | ${m.real.detScoreMean} | ${m.degraded.detScoreMean} | **${m.discriminationDet}** | ${m.discriminationPass ? '✅' : '❌'} | ${m.real.refusalCorrectRate ?? '—'} | ${m.real.costUsd} | ${m.real.turnsMean} |`)
  }
  L.push(``)
  L.push(`## Cross-model (real variant judge mean)`)
  L.push(``)
  const models = report.models
  L.push(`| system | ${models.map(x => x + ' real').join(' | ')} | ${models.map(x => x + ' Δ').join(' | ')} |`)
  L.push(`|--------|${models.map(() => '---').join('|')}|${models.map(() => '---').join('|')}|`)
  for (const [sys, m] of Object.entries(report.perSystem)) {
    const real = models.map(x => m.perModel[x]?.real?.judgeMean ?? '—')
    const disc = models.map(x => m.perModel[x]?.discriminationJudge ?? '—')
    L.push(`| ${sys} | ${real.join(' | ')} | ${disc.join(' | ')} |`)
  }
  L.push(``)
  L.push(`## Regression vs baseline`)
  L.push(``)
  for (const [sys, r] of Object.entries(report.regression)) {
    L.push(`- **${sys}**: ${r.status}${r.deltas ? ' — Δ ' + JSON.stringify(r.deltas) : ''}`)
  }
  L.push(``)
  L.push(`## Case appendix (real variant)`)
  L.push(``)
  L.push(`| case | model | det | judge | verdict | denied | commits | critical failures |`)
  L.push(`|------|-------|-----|-------|---------|--------|---------|-------------------|`)
  for (const r of records.filter(r => r.variant === 'real').sort((a, b) => (a.caseId ?? '').localeCompare(b.caseId ?? ''))) {
    L.push(`| ${r.caseId} | ${r.model} | ${r.det?.detPass ? '✅' : '❌'} ${(r.det?.detScore ?? 0).toFixed(2)} | ${r.judge?.overall ?? '—'} | ${r.judge?.verdict ?? '—'} | ${(r.dispatch?.deniedTools ?? []).join(',') || '—'} | ${r.post?.newCommits ?? '—'} | ${(r.det?.criticalFailures ?? []).join('; ') || '—'} |`)
  }
  L.push(``)
  return L.join('\n')
}
