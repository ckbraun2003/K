// DB-backed registry for the ported T-EVAL harness (F3.W1b). Two functions:
//   seedEvalSystems()   — file → DB: testing/eval/systems.json (+ each system's cases file and an
//                         optional baselines/<id>.json) upserted into eval_systems/eval_cases/
//                         eval_baselines. Idempotent: systems/baselines upsert by primary key and a
//                         system's cases are delete+reinserted, so re-seeding never duplicates rows.
//   loadSystemsFromDb() — DB → the SAME EvalSystem[] shape loadSystems() returns, a drop-in for the
//                         runner. Resolves promptFile/degradedFile/rubricFile to absolute paths and
//                         reads rubricText from the rubric file, exactly as the file loader does.
//
// Prompt/degraded/rubric are stored as registry-relative PATH strings (never the prompt text) and
// resolved against the repo root on load. Statements are prepared on the resolved connection so an
// isolated (injected) DB can be driven as well as the module singleton.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { db as moduleDb } from '../db.js'
import { repoRoot } from './systems.js'
import type { Check, EvalCase, EvalSystem, SystemRegistry, SystemRegistryEntry } from './types.js'

// loadSystems() applies these defaults when the registry omits the field; seed stores the resolved
// value so loadSystemsFromDb() is equivalent regardless of which fields the registry author omitted.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']
const DEFAULT_DISALLOWED_TOOLS = ['Task']
const DEFAULT_MAX_TURNS = 14

/** Narrow row shapes for the two tables this module reads back. */
interface EvalSystemRow {
  id: string
  title: string
  job: string | null
  promptFile: string
  degradedFile: string | null
  rubricFile: string | null
  allowedTools: string
  disallowedTools: string
  maxTurns: number
}
interface EvalCaseRow {
  id: string
  systemId: string
  title: string | null
  input: string
  fixture: string | null
  checks: string
  allowedTools: string | null
  refusalExpected: number | null
  judgeEnabled: number | null
  maxTurns: number | null
  timeoutMs: number | null
}

const abs = (base: string, p: string): string => (path.isAbsolute(p) ? p : path.join(base, p))

/** Seed testing/eval/* into the eval_* tables. Idempotent upsert; returns counts. */
export function seedEvalSystems(
  opts: { root?: string; db?: Database.Database } = {},
): { systems: number; cases: number; baselines: number } {
  const base = opts.root || repoRoot()
  const d = opts.db ?? moduleDb
  const regPath = path.join(base, 'testing', 'eval', 'systems.json')
  // narrow JSON boundary: systems.json is authored to the SystemRegistry shape
  const registry = JSON.parse(readFileSync(regPath, 'utf8')) as SystemRegistry

  const upsertSystem = d.prepare(`
    INSERT INTO eval_systems (id, title, job, promptFile, degradedFile, rubricFile, allowedTools, disallowedTools, maxTurns, enabled, createdAt)
    VALUES (@id, @title, @job, @promptFile, @degradedFile, @rubricFile, @allowedTools, @disallowedTools, @maxTurns, @enabled, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      title           = excluded.title,
      job             = excluded.job,
      promptFile      = excluded.promptFile,
      degradedFile    = excluded.degradedFile,
      rubricFile      = excluded.rubricFile,
      allowedTools    = excluded.allowedTools,
      disallowedTools = excluded.disallowedTools,
      maxTurns        = excluded.maxTurns,
      enabled         = excluded.enabled
  `)
  const deleteCases = d.prepare(`DELETE FROM eval_cases WHERE systemId = ?`)
  const insertCase = d.prepare(`
    INSERT INTO eval_cases (id, systemId, title, input, fixture, checks, allowedTools, refusalExpected, judgeEnabled, maxTurns, timeoutMs, createdAt)
    VALUES (@id, @systemId, @title, @input, @fixture, @checks, @allowedTools, @refusalExpected, @judgeEnabled, @maxTurns, @timeoutMs, @createdAt)
  `)
  const upsertBaseline = d.prepare(`
    INSERT INTO eval_baselines (systemId, metrics, evalRunId, frozenAt)
    VALUES (@systemId, @metrics, @evalRunId, @frozenAt)
    ON CONFLICT(systemId) DO UPDATE SET metrics = excluded.metrics, evalRunId = excluded.evalRunId, frozenAt = excluded.frozenAt
  `)

  const now = Date.now()

  // Per-system, in one transaction: upsert the system, then replace its cases wholesale (delete +
  // reinsert) so a removed/renamed case can't linger. Returns the case count for this system.
  const seedOne = d.transaction((entry: SystemRegistryEntry): number => {
    upsertSystem.run({
      id: entry.id,
      title: entry.title,
      job: entry.job ?? entry.title,
      promptFile: entry.promptFile,
      degradedFile: entry.degradedFile ?? null,
      rubricFile: entry.rubric ?? null,
      allowedTools: JSON.stringify(entry.allowedTools ?? DEFAULT_ALLOWED_TOOLS),
      disallowedTools: JSON.stringify(entry.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS),
      maxTurns: entry.maxTurns ?? DEFAULT_MAX_TURNS,
      enabled: 1,
      createdAt: now,
    })
    deleteCases.run(entry.id)
    const casesPath = abs(base, entry.casesFile)
    // narrow JSON boundary: a cases file is authored as an EvalCase[]
    const list = JSON.parse(readFileSync(casesPath, 'utf8')) as EvalCase[]
    for (const c of list) {
      insertCase.run({
        id: c.id,
        systemId: entry.id,
        title: c.title ?? null,
        input: c.input,
        fixture: c.fixture ?? null,
        checks: JSON.stringify(c.checks ?? []),
        allowedTools: c.allowedTools ? JSON.stringify(c.allowedTools) : null,
        refusalExpected: c.refusalExpected == null ? null : c.refusalExpected ? 1 : 0,
        judgeEnabled: c.judge == null ? null : c.judge ? 1 : 0,
        maxTurns: c.maxTurns ?? null,
        timeoutMs: c.timeoutMs ?? null,
        createdAt: now,
      })
    }
    return list.length
  })

  let cases = 0
  let baselines = 0
  for (const entry of registry.systems) {
    cases += seedOne(entry)
    // Optional frozen baseline — testing/eval/baselines/<id>.json. Stored verbatim as JSON; the
    // file's ISO frozenAt becomes an epoch-ms column (now() fallback if absent/garbled).
    const baselinePath = path.join(base, 'testing', 'eval', 'baselines', `${entry.id}.json`)
    if (existsSync(baselinePath)) {
      const raw = readFileSync(baselinePath, 'utf8')
      // narrow JSON boundary: baseline files carry an ISO `frozenAt`
      const parsed = JSON.parse(raw) as { frozenAt?: string }
      const frozen = parsed.frozenAt ? Date.parse(parsed.frozenAt) : NaN
      upsertBaseline.run({
        systemId: entry.id,
        metrics: raw,
        evalRunId: null,
        frozenAt: Number.isNaN(frozen) ? now : frozen,
      })
      baselines += 1
    }
  }

  return { systems: registry.systems.length, cases, baselines }
}

/** DB row → EvalCase, reconstructing only the fields the source authored (optional cols → omitted). */
function rowToEvalCase(r: EvalCaseRow): EvalCase {
  // narrow JSON boundary: checks is the authored CHECKS DSL array
  const c: EvalCase = { id: r.id, input: r.input, checks: JSON.parse(r.checks) as Check[] }
  if (r.title != null) c.title = r.title
  if (r.fixture != null) c.fixture = r.fixture
  if (r.allowedTools != null) c.allowedTools = JSON.parse(r.allowedTools) as string[]
  if (r.refusalExpected != null) c.refusalExpected = r.refusalExpected === 1
  if (r.judgeEnabled != null) c.judge = r.judgeEnabled === 1
  if (r.maxTurns != null) c.maxTurns = r.maxTurns
  if (r.timeoutMs != null) c.timeoutMs = r.timeoutMs
  return c
}

/** Read eval_systems (+ their eval_cases) back into the EvalSystem[] shape loadSystems() returns. */
export function loadSystemsFromDb(
  opts: { root?: string; only?: string[]; db?: Database.Database } = {},
): EvalSystem[] {
  const base = opts.root || repoRoot()
  const d = opts.db ?? moduleDb
  const onlySet = opts.only && opts.only.length ? new Set(opts.only) : null

  const sysRows = d.prepare(`SELECT * FROM eval_systems ORDER BY id`).all() as EvalSystemRow[]
  const caseStmt = d.prepare(`SELECT * FROM eval_cases WHERE systemId = ? ORDER BY id`)

  const out: EvalSystem[] = []
  for (const r of sysRows) {
    if (onlySet && !onlySet.has(r.id)) continue
    const caseRows = caseStmt.all(r.id) as EvalCaseRow[]
    out.push({
      id: r.id,
      title: r.title,
      job: r.job ?? r.title,
      promptFile: abs(base, r.promptFile),
      degradedFile: r.degradedFile ? abs(base, r.degradedFile) : '',
      allowedTools: JSON.parse(r.allowedTools) as string[],
      disallowedTools: JSON.parse(r.disallowedTools) as string[],
      maxTurns: r.maxTurns,
      rubricText: r.rubricFile ? readFileSync(abs(base, r.rubricFile), 'utf8') : '',
      cases: caseRows.map(rowToEvalCase),
    })
  }
  return out
}
