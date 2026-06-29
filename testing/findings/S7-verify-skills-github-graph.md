# S7 — Verification, Skills, GitHub, Graph

Suite Orchestrator: S7. Systems: `core/src/verify.ts` (health-score engine + auditors + scaffold +
atomic persist), `core/src/skills.ts` + the `skill_evals` table (eval recording / regression
detection / degrade), `core/src/github.ts` + `core/src/github-parse.ts` (createPR, poller, gh-JSON
projections), `core/src/graph.ts` + the `GET /api/projects/:id/graph` route in
`core/src/routes/projects.ts` (graph.json normalization).

Prober: three independent adversarial `Explore` sub-agents (probe pass — one each on verify,
github+skills, graph), each reading source + existing tests and returning concrete concern
candidates. Validator: `agent:s7-orchestrator (validate pass)` — every concern re-driven through an
independent, isolated-`K_DATA_DIR` vitest run; irreproducible candidates dropped. Each row below is
codified by a committed test; the LOCK tests pass, the one FAULT test is red by design.

LOCK = current behavior is correct → green test in the gating suite.
FAULT = confirmed bug → red test in `core/test/regressions/**`, linked to the finding id.

## Summary

| Severity | LOCK | FAULT | Total |
|----------|------|-------|-------|
| High     | 0    | 0     | 0 |
| Medium   | 5    | 1     | 6 |
| Low / Nit| 8    | 0     | 8 |
| **Total**| **13** | **1** | **14 findings across 31 LOCK tests + 1 FAULT test** |

Headline: the three pure projection/scoring cores (`computeHealthScore`, `github-parse`,
graph-route normalization) are well-defended against weird input — except one gap: the **GET /graph
route normalizes graph.json with an unguarded `.map`**, so a single `null`/non-object entry in the
`nodes` (or `links`) array throws and the outer catch collapses the **entire** graph view to empty
(S7-001, FAULT). The build layer's `toGraphJson` filters per-entry; the route does not. Everything
else holds: scaffolded CI is left uncommitted, persistReport is atomic, createPR is argv-injection-
safe, the poller degrades cleanly, and skill-eval regression fires only on a was-pass→now-fail.

---

## Findings

| id | system | severity | category | surface | repro | expected | actual | classification | test-path | status |
|----|--------|----------|----------|---------|-------|----------|--------|----------------|-----------|--------|
| **S7-001** | **graph route** | **Medium** | **Bug** | **`routes/projects.ts` GET /graph — inline `(data.nodes ?? []).map(n => ({id: n.id ?? n.name, …}))` + the same for links** | **graph.json `nodes:[{id:'good1'},null,{id:'good2'}]`; GET /graph** | **malformed entries skipped; the valid nodes/links still render** | **`n.id` on the null throws TypeError → outer catch returns `{nodes:[],links:[],stale:true}` — ALL good nodes/links lost** | **FAULT** | **`core/test/regressions/s7-001-graph-route-null-node-collapses-view.test.ts`** | **quarantined** |
| S7-002 | verify (health score) | Low | Edge | `computeHealthScore` | cartesian product of every CiState × CoverageTrend × bibleFresh × findings-pile (incl. 50 warns, 20 criticals) | score is always an integer in [0,100]; findings component never negative | matches — always integer, clamped, findings floored at 0 | LOCK | `core/test/campaign-s7-verify.test.ts` | codified |
| S7-003 | verify (CI classify) | Low | Robustness | `classifyCi` sort by `Date.parse(createdAt)` | runs with `createdAt` `''` / `'not-a-date'` mixed with valid | NaN-sort does not change a CONSISTENT verdict (all-success→passing, all-fail→failing, mixed→flaky) | matches — consistency makes ordering irrelevant; malformed dates are harmless | LOCK | `core/test/campaign-s7-verify.test.ts` | codified |
| S7-004 | verify (scaffold) | Medium | Robustness | `runVerification` → `scaffoldCi` (deterministic CI fix) | bare project in a real git repo; run verification | scaffolded `.github/workflows/ci.yml` is written to the working tree but left UNCOMMITTED (untracked, never git-added); score still reflects CI-missing this run | matches — file present + `?? .github/workflows/ci.yml` + not in `git ls-files`; ci component 0, score 20 | LOCK | `core/test/campaign-s7-verify.test.ts` | codified |
| S7-005 | verify (persist) | Medium | Robustness | `persistReport` atomic contract (report insert + project-health update in one `db.transaction`) | run the two real prepared statements in a txn that throws after the insert | both writes land or neither — a mid-write failure rolls the insert back; project health untouched | matches — rollback confirmed; the successful txn commits both | LOCK | `core/test/campaign-s7-verify.test.ts` | codified |
| S7-006 | skills (eval) | Low | Edge | `finalizeSkillEval` regression rule | seed prior completed eval; finalize new pass/fail | regression flagged ONLY for was-pass→now-fail; pass→pass and fail→pass are not regressions (baseline still linked) | matches | LOCK | `core/test/campaign-s7-skills-eval.test.ts` | codified |
| S7-007 | skills (eval) | Low | Edge | `finalizeSkillEval` → `latestCompletedSkillEval` (`status IN ('pass','fail')`) | seed older completed pass + a newer PENDING row; finalize new fail | baseline resolves to the completed pass (pending row ignored) → regression true | matches — a still-pending eval is never used as a baseline | LOCK | `core/test/campaign-s7-skills-eval.test.ts` | codified |
| S7-008 | skills (eval) | Medium | Robustness | `runSkillTest` no-dispatch degrade (startRun throws) | mock `startRun` to reject; call `runSkillTest` | no crash; a durable `fail` eval row with completedAt; empty runId; no leaked `pending` row | matches — returns `{evalId, runId:''}`, row finalized `fail`, no spurious regression | LOCK | `core/test/campaign-s7-skills-eval.test.ts` | codified |
| S7-009 | github-parse | Low | Robustness | `parsePrList` / `parseCiRuns` / `parseIssueList` | 15-input adversarial sweep (null/undefined/number/string/`[null]`/`[{number:'x'}]`/nested) | never throws; always returns an array | matches across all three | LOCK | `core/test/campaign-s7-github.test.ts` | codified |
| S7-010 | github-parse | Low | Edge | `parsePrList` rollup / `parseCiRuns` id-guard | extra/hostile fields; `javascript:` url; non-array `statusCheckRollup`; non-object rollup entries; float `databaseId` | extras ignored; bad url → ''; non-array rollup → 'none'; non-object entries → 'pending'; float id accepted as-is | matches (characterization — float id + non-array rollup are defensive, not strict) | LOCK | `core/test/campaign-s7-github.test.ts` | codified |
| S7-011 | github (createPR) | Medium | Robustness | `createPR` execa argv | call with hostile title/body/head/base full of shell metacharacters | bare `gh` binary + discrete argv array (no shell), exact flag order, every value verbatim as one element, no `--json` | matches — no shell option, values pass through unsplit | LOCK | `core/test/campaign-s7-github.test.ts` | codified |
| S7-012 | github (poller) | Low | Robustness | `__pollOnce` with a throwing fetch (gh absent) | inject a fetcher that throws ENOENT | no crash; cache untouched; no broadcast; reentrancy guard released so a later poll works | matches — degrades + recovers | LOCK | `core/test/campaign-s7-github.test.ts` | codified |
| S7-013 | graph route | Low | Edge | GET /graph inline normalization | graph.json with `edges`+`from`/`to`; nodes missing id/name/label | `edges`→`links`, `from`/`to`→`source`/`target`; id falls back to name, label name→id | matches | LOCK | `core/test/campaign-s7-graph.test.ts` | codified |
| S7-014 | graph route | Low | Robustness | GET /graph degrade path | graph.json with a non-array `nodes`; unparseable JSON | degrades to empty + stale, 200 (no 500) | matches — WHOLLY-malformed artifacts degrade cleanly (contrast S7-001: a VALID array with one bad entry must NOT) | LOCK | `core/test/campaign-s7-graph.test.ts` | codified |

---

## S7-001 (FAULT) — detail

The `GET /api/projects/:id/graph` route reads the project's `.gitnexus/graph.json` and normalizes it
**inline** with an unguarded `.map` (`core/src/routes/projects.ts`):

```ts
const baseNodes = (data.nodes ?? []).map(n => ({ id: n.id ?? n.name, label: n.label ?? n.name ?? n.id, …, ...n }))
…
const links = (data.links ?? data.edges ?? []).map(e => ({ source: e.source ?? e.from, target: e.target ?? e.to, … }))
```

If `data.nodes` is a valid array that contains a single `null` (or other non-object) entry among
valid ones, evaluating `n.id` on the null throws a `TypeError`. That throw is caught by the route's
**outer** try/catch, whose handler returns the fully degraded `{ nodes: [], links: [], stale: true,
… }`. So **one bad node zeroes out the whole graph** — every good node *and* link is discarded — and
the operator sees an empty graph with a "stale" banner instead of "the graph minus one malformed
node". The `links` array shares the identical root cause (a null link entry throws on `e.source`).

**Contrast with the build layer (why this is a real gap).** `toGraphJson` (`core/src/graph.ts`)
filters per-entry (`.filter(n => n && typeof n === 'object' && typeof n.id === 'string')`) precisely
so one bad row can't poison the set. The route does **not** apply the same per-entry guard, so the
robustness contract is upheld on the write path but violated on the read path.

**Reachability.** `graph.json` is produced by the **external** `npx gitnexus analyze` CLI and read
verbatim from disk by the route. A corrupt/partial write, a tool-version change, or a hand-edited /
third-party artifact that lands a `null` in either array is consumed directly — there is no schema
validation between the file and the `.map`. The harness's OWN exporter never emits nulls (toGraphJson
filters them), so this requires an externally-produced or corrupted artifact; severity is **Medium**
(no server crash — the response is still 200 — but it is whole-graph data loss in the view, silently,
with only a `warn`-level log).

**Suggested fix (a finding, not an edit).** Apply the same per-entry guard the build layer uses:
filter `data.nodes` / `data.links` to truthy objects before mapping (e.g.
`.filter(n => n && typeof n === 'object')`), so a malformed entry is skipped individually and the
valid graph still renders. The red test asserts that behavior and flips green when fixed → move it
into `core/test/`.

---

## Cross-cutting notes / latent risks (documented, no separate red test)

- **`rowToReport` silently drops a corrupt `score_breakdown`** (`core/src/db.ts`). If the JSON
  column is malformed (manual edit / corruption), the catch omits `breakdown` from the returned
  report with no log. Latent (the code always `JSON.stringify`s it on write); flag for whoever adds
  external report ingestion. Not in S7's charter vectors — noted only.
- **`hasBibleDir` vs `auditInvariants` bibleDir fallback** (`verify.ts`). `hasBibleDir` uses
  `project.bibleDir` directly while `auditInvariants` applies `project.bibleDir || 'artifacts/bible'`.
  If `bibleDir` were ever empty the two would disagree on the path. Latent only — the DB schema gives
  `bibleDir` a non-empty default and the type requires it, so it is unreachable in production.
- **`parseCiRuns` accepts a float `databaseId`; a non-array `statusCheckRollup` reads as `'none'`**
  (S7-010). Both are *defensive* (never throw) rather than *strict*; documented as characterization,
  not bugs — GitHub never sends those shapes, and the projection degrades sensibly if it ever did.

## Run commands & results

Isolation rule honored — a unique `K_DATA_DIR` per invocation (never colliding with the parallel S6
agent). Each file run on its own; quarantine via the regressions config.

```bash
# GATING (LOCK) — each file in its own data dir; all green (31 tests / 4 files)
cd core
for f in campaign-s7-verify campaign-s7-skills-eval campaign-s7-github campaign-s7-graph; do
  K_DATA_DIR="$(mktemp -d)/k-s7-$f" npx vitest run "test/$f.test.ts" --config vitest.config.ts
done

# QUARANTINE (FAULT) — red by design
K_DATA_DIR="$(mktemp -d)/k-s7-reg" npx vitest run --config vitest.regressions.config.ts \
  test/regressions/s7-001-graph-route-null-node-collapses-view.test.ts
```

Results (2026-06-28):
- `campaign-s7-verify.test.ts` — 9 passed
- `campaign-s7-skills-eval.test.ts` — 5 passed
- `campaign-s7-github.test.ts` — 12 passed
- `campaign-s7-graph.test.ts` — 5 passed
- `regressions/s7-001-graph-route-null-node-collapses-view.test.ts` — 1 failed (RED, as designed):
  `expected [] to deeply equal [ 'good1', 'good2' ]` (the route's own log shows the TypeError →
  degraded-path collapse, confirming the fault).
