/**
 * Integration test for the matrix runner (core/src/eval/runner.ts) on the DRY path — ZERO token
 * spend, NO real claude.exe dispatch. Uses the REAL testing/eval/ registry+cases via an injected
 * `root`, but a temp `baseDir` (disposable sandboxes) and a temp `reportsDir` (JSONL + md/json
 * report) so nothing is written under testing/eval/reports/.
 *
 * The system + case under test are picked DYNAMICALLY from the registry (first system, first case)
 * so a rename/removal in systems.json can't silently break this test with a cryptic loader error.
 * BOTH variants (real + degraded) are run so the degraded dryResult() branch is exercised too.
 *
 * Asserts: a well-formed EvalReport is returned; overall.totalCostUsd === 0; the JSONL checkpoint +
 * md/json reports land in the temp dir; both fabricated (dry) records were used (real + degraded,
 * not a dispatch); and a second call RESUMES — recorded jobs are skipped (no duplicate JSONL lines).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvalMatrix } from '../src/eval/runner.js'
import { loadSystems } from '../src/eval/systems.js'
import type { EvalRecord } from '../src/eval/types.js'

// core/test/<this> → repo root is two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const reportsDir = mkdtempSync(path.join(os.tmpdir(), 'k-eval-reports-'))
const baseDir = mkdtempSync(path.join(os.tmpdir(), 'k-eval-base-'))

// Pick the first registered system + its first case dynamically — no coupling to a specific id.
const firstSystem = loadSystems({ root })[0]
const SYS = firstSystem.id
const CASE = firstSystem.cases[0].id

const RUN_ID = 'unit-dry'           // becomes `unit-dry-dry` (the runner appends `-dry`)
const FULL_ID = `${RUN_ID}-dry`
const opts = {
  root, reportsDir, baseDir, dry: true,
  systems: [SYS], cases: [CASE], models: ['sonnet'], variants: ['real', 'degraded'], runId: RUN_ID,
}

afterAll(() => {
  for (const d of [reportsDir, baseDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

function readJsonl(): EvalRecord[] {
  const p = path.join(reportsDir, '_runs', FULL_ID, 'results.jsonl')
  return readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s) as EvalRecord)
}

describe('runEvalMatrix — dry path (no dispatch, no spend)', () => {
  it('returns a well-formed report, costs $0, and writes outputs to the temp dir', async () => {
    const report = await runEvalMatrix(opts)

    expect(report.runId).toBe(FULL_ID)
    expect(report.dry).toBe(true)
    expect(report.overall.totalCostUsd).toBe(0)
    expect(report.overall.totalRecords).toBe(2)        // real + degraded
    expect(report.perSystem[SYS]).toBeDefined()
    expect(report.models).toEqual(['sonnet'])
    expect(report.variants).toEqual(['real', 'degraded'])

    // checkpoint + reports all under the temp dir (NOT testing/eval/reports/)
    const jsonlPath = path.join(reportsDir, '_runs', FULL_ID, 'results.jsonl')
    expect(existsSync(jsonlPath)).toBe(true)
    expect(existsSync(path.join(reportsDir, `${FULL_ID}.json`))).toBe(true)
    expect(existsSync(path.join(reportsDir, `${FULL_ID}.md`))).toBe(true)

    // two records, both fabricated (dry) — proving dispatch was bypassed (no claude.exe spawn)
    const recs = readJsonl()
    expect(recs).toHaveLength(2)
    for (const r of recs) {
      expect(r.metricsRaw?.costUsd).toBe(0)
      expect(r.dispatch?.outcome).toBe('closed')
      expect(r.judge).toBeNull()                         // judge is skipped on the dry path
    }
    // each variant's dryResult() text marker proves the fabricated branch (real vs degraded) was taken
    const real = recs.find(r => r.variant === 'real')
    const degraded = recs.find(r => r.variant === 'degraded')
    expect(real?.dispatch?.textHead).toContain('stay within the worktree')
    expect(degraded?.dispatch?.textHead).toContain('Sure, done.')

    // no baselines were frozen on a dry run
    expect(report.baselinesFrozen).toEqual([])
  })

  it('SAFE-BY-DEFAULT: omitting `dry` resolves to a DRY run (F4.W2 token-safety lock)', async () => {
    // runEvalMatrix defaults `dry` to TRUE (opts.dry !== false), so a caller that forgets the flag
    // can NEVER spawn claude.exe. Inject an EMPTY registry (0 jobs) so this can't dispatch even if the
    // default ever regressed, and assert the run still resolved to dry. If the default regressed to
    // real-dispatch, report.dry would be false here and this test goes red — without any spend.
    const report = await runEvalMatrix({
      root, reportsDir, baseDir, runId: 'unit-default',
      loadSystemsFn: () => [], // 0 systems → 0 jobs → no dispatch under any dry value
      // `dry` intentionally OMITTED — must default to true
    })
    expect(report.dry).toBe(true)
    expect(report.overall.totalCostUsd).toBe(0)
    expect(report.overall.totalRecords).toBe(0)
  })

  it('a second call RESUMES — recorded jobs are skipped (no duplicate JSONL lines)', async () => {
    const before = readJsonl().length
    expect(before).toBe(2)
    await runEvalMatrix(opts) // same runId + reportsDir → resume
    const after = readJsonl()
    expect(after).toHaveLength(2) // not appended again
    expect(after.map(r => r.jobKey).sort()).toEqual(
      [`${CASE}::sonnet::degraded`, `${CASE}::sonnet::real`].sort(),
    )
  })
})
