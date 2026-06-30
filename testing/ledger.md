# Campaign ledger

Branch: `test/rigorous-campaign` (off `main`). Director-maintained.

## Baseline (Wave 0, 2026-06-28)

Recorded starting state on a clean checkout before any campaign tests:

| Gate | Result |
|------|--------|
| `pnpm typecheck` | ✅ green (shared + core + web) |
| `pnpm -r test` | ✅ green — core **59 files / 714 tests**, web **26 files / 254 tests** (968 total) |
| `pnpm build` | ✅ green (core tsc + web tsc && vite build) |

Quarantine + eval harness: scaffolded empty (no findings yet).

## Wave status

| Wave | Suite | Status | Findings (C/H/M/L+Nit) | LOCK tests | FAULT (quarantine) | Commit |
|------|-------|--------|--------------------|-----------|--------------------|--------|
| 0 | Scaffold + baseline | ✅ done | — | — | — | c4fcef0, 4842c86 |
| 1 | S1 Database & Persistence | ✅ done | 0/0/1/23 | 37 (7 files) | 1 — S1-018 | (S1 commit) |
| 2 | S2 Memory & Work-Tracking | ✅ done | 0/0/4/13 | 20 (5 files) | 1 — S2-017 | (S2 commit) |
| 3 | S3 MCP Working Store (kstore) | ✅ done | 0/0/0/11 | 26 (2 files) | 1 — S3-001 | (S3 commit) |
| 4 | S4 Prompt & Delegation Synthesis | ✅ done | 0/0/5/13 | 29 (6 files) | 1 — S4-018 | a50ac31 |
| 5 | S5 Supervisor/Providers/Routing | ✅ done | 0/0/0/24 | 124 (6 files) | 4 — S5-001..004 | a2d8b27 |
| 6 | S6 Voice & Bible | ✅ done | 0/0/2/12 | 30 (4 files) | 4 — S6-001..004 | 923d594 |
| 7 | S7 Verify/Skills/GitHub/Graph | ✅ done | 0/0/6/8 | 31 (4 files) | 1 — S7-001 | 8ca48d3 |
| 8 | S8 Web/UI & E2E | ✅ done | 0/2/2/7+1Nit | 25 (5 files, S8a) | 5 — S8-001..005 | 7f0f3db (S8a), 1dbf21e (S8b) |
| 9 | T-EVAL prompt-eval harness | ✅ done | 0/0/1/2 | 0 (eval, not vitest) | 0 — see T-EVAL-001..003 | (W9 commit) |
| 10 | Consolidate | ✅ done | — | 322 total (LOCK) | 18 files total (FAULT) | (W10 commit) |

**Batch A integration (S1–S3):** full core gating suite **green + stable ×3** (797 tests, up from
714 baseline); quarantine **red ×3 faults** as designed. Test-runner hardened to a single serial
fork (no SQLITE_BUSY, no native teardown segfault).

**Batch B integration (S4–S5):** full gating suite **green** — core **950 tests** (up from 797),
web **254 tests**; quarantine **red ×8 files / 19 tests** as designed (3 Batch A + 5 Batch B faults).
Document-only invariant verified (zero drift in `core/src`, `shared/src`, `web`, `agent-config`, vitest
configs). Each suite spec+quality reviewed before commit; the one review blocker (S5-001 severity
overstated) was corrected — downgraded Med→Low (latent: no shipped caller passes `maxCostUsd`).

**Batch C integration (S6–S7):** full gating suite **green + stable ×2** — core **1011 tests** (up
from 950), web **254**; quarantine **red ×13 files / 28 tests** as designed (3 A + 5 B + 5 C faults).
The full integration gate caught **two isolation defects the isolated per-suite runs missed**, fixed
test-side (no app source touched): (1) the S6 `@live:stats` LOCK assumed a globally-empty `runs` table
(shared suite DB) → made count-branch-aware; (2) `graph.test.ts`'s pre-existing 20ms fire-and-forget
race surfaced under the heavier suite → hardened to poll-until-ready (assertion unchanged). Review
blocker corrected: **S6-001 stored-XSS downgraded High→Med** + reachability disclosure (no HTTP/UI
route persists frontmatter; author/agent-controlled on-disk `.md` only — same reach as the Low S6-002
slug sink). S6-004 quarantine test broadened to accept either endorsed fix (coerce-string OR reject).

**Batch D integration (S8 — toolchain shift to web):** dispatched as two parallel orchestrators on
different runners/dirs (no collision). **S8a Web/UI pure-logic** (jsdom/node vitest): full web gating
suite **green** — **279 tests** (up from 254, +25 LOCK across 5 files); web quarantine **red ×5 files /
14 tests + 1 green sanity guard** (the cron-DoS worker harness self-check). The cron fault (S8-003) is
detected by compiling the REAL `cron.ts` in-runtime (`vite.transformWithEsbuild`, no source copy) and
running it in a **heap-constrained disposable `worker_threads` worker** — so a `*/0` OOM / oversized-range
freeze is observed machine-independently without ever crashing the runner. **S8b E2E persona-swarm**
(Playwright/chromium, isolated-port harness): two new resilient personas **P11** (workflow checklist,
5/5) + **P12** (settings + voice, 6/6) boot a fresh stack each and pass green-resilient with zero uncaught
page errors / console.errors; findings are observations (no gating-vitest contribution). Core suite
untouched (no `core/src`/`core/test` change) — stays at **1011**. Document-only invariant verified (zero
drift in app source + configs). Review blocker corrected: **S8-002 downgraded High→Low (latent)** — an
out-of-enum workflow step status is double-gated (kstore Zod enum `k-store.ts:202` + DB `CHECK`
`db.ts:219-220`), unreachable from shipped data and strictly more guarded than the non-codified S8-011;
its RED test is retained as a forward-compat *enum-drift* blast-radius guard. Nits applied: S8-001
reachability caveat (null entry presumes a malformed/partial frame), S8-003 prose notes the test uses 5M.

**Wave 9 (T-EVAL — agent/skill/prompt eval harness; the one sanctioned real-token-spend wave):** built
a real-dispatch eval harness under `testing/eval/` (operator-triggered; **not** in `pnpm -r test`; **0
LOCK / 0 FAULT** vitest contribution — document-only on app source HOLDS, the real `agent-config/`
prompts are READ via `--append-system-prompt-file`, never edited). 6 systems × 8 cases (L0,
secretary, orchestrator, spec-reviewer, implementer, verification) dispatched on **both Opus + Sonnet**
× {real, degraded-anti-prompt}, graded deterministically + by a fixed-Opus LLM judge, with frozen
baselines + a degraded-anti-prompt discrimination control. Run `wave9`: **192 records, 0 errors,
$61.81**. Discrimination demonstrated on the K-DISTINCTIVE systems (secretary det Δ **+0.221** / judge
+0.356; orchestrator +0.156 / +0.179); inconclusive-by-construction on the base-CC-overlap systems
(L0/spec-reviewer/verification near a ceiling) and the edit-confounded implementer — **all 6 det deltas
positive** (real never worse than its anti-prompt). Key finding **T-EVAL-001** (Med): K's tier/worker
prompts hold on Opus but slip on Sonnet (secretary attempted code tools, L0 fabricated/committed-to-main
on Sonnet) — the `--allowedTools` allowlist, not the prompt, is the real backstop (defense-in-depth
validated). Confined tools-enabled, `acceptEdits` (no bypass — the auto-mode classifier correctly blocks
it, matching the no-bypass rule). Independent reviewer **recomputed all 192 aggregates from raw JSONL**
(reconcile to 3 dp) → **APPROVE-WITH-NITS**; nits applied (token capture, non-repo created-file
detection, resume-retries-errored) or deferred to the next baseline (L0-07 commit-check, format-array
tightening — held to keep cases consistent with the frozen baselines). Gating suite unchanged (no vitest
file touched): **core 1011 + web 279** green; quarantine **18 files** red-by-design.

**Wave 10 (Consolidate — reconciliation + summary; no token spend):** re-ran every gate from a clean
tree at HEAD `8a5fcbd` and reconciled the ledger against ground truth.
- **Gating GREEN:** core **1011 passed / 93 files**, web **279 passed / 31 files** (1290 total). The
  campaign added exactly **+34 core files (714→1011, +297)** and **+5 web files (254→279, +25)** =
  **322 new passing LOCK tests** over the Wave-0 baseline.
- **Quarantine RED-by-design:** core **13 files / 28 tests failed**; web **5 files / 14 failed + 1
  passed** (the cron-DoS `worker_threads` self-check sanity guard) = **18 fault files**, one per
  confirmed finding.
- **LOCK reconciliation:** total committed gating tests (322) now equals the sum of the wave-table LOCK
  column. Correction applied this wave: the S1/S2/S3 LOCK cells were recorded at ~their *finding* counts
  (23/16/10) rather than their actual vitest *case* counts (**37/20/26**, confirmed by re-run); S4–S7
  (29/124/30/31) and S8a-web (25) already matched. The integration-note running totals were always
  consistent (Batch A 797 = 714+83 where 37+20+26=83; B 950 = 797+153 where 29+124=153; C 1011 =
  950+61 where 30+31=61) — only the per-row column was understated.
- **FAULT reconciliation:** 18 wave-table FAULT rows (S1-018, S2-017, S3-001, S4-018, S5-001..004,
  S6-001..004, S7-001, S8-001..005) == 18 files in `core/test/regressions/**` (13) + `web/test/
  regressions/**` (5); every row links to a real, currently-RED test path.
- **T-EVAL exempt** (Wave 9): operator-triggered eval, not vitest → 0 LOCK / 0 FAULT, per the
  reconciliation rule.
- **Document-only invariant HELD across all 10 waves:** zero drift in `core/src`, `web/src`,
  `shared/src`, `agent-config/**`, or any vitest config beyond the additive campaign env-honoring change
  committed in Wave 0. Every confirmed source-affecting issue is a quarantined FINDING, never an edit.
- Campaign summary written to `testing/SUMMARY.md` (waves, severity tally, repeatable-pipeline record).

## Finding index

### Confirmed FAULTs (quarantined, awaiting operator triage/fix)
| id | sev | system | one-liner | quarantine test |
|----|-----|--------|-----------|-----------------|
| **S3-001** | Low | k-store.ts | omitted MCP `arguments` rejected for all-optional tools (should default to `{}`) | `core/test/regressions/s3-001-optional-args-omitted.test.ts` |
| **S4-018** | Low | workflows.ts | empty-taskIds `dispatchTaskWorkflow` validates-after-mutate → orphan `failed` workflow_run row (route-guarded ≥1; direct-caller seam) | `core/test/regressions/s4-018-empty-dispatch-orphan-row.test.ts` |
| **S5-001** | Low (latent) | supervisor.ts/router.ts | explicit `claude-*` model + `maxCostUsd` cost-branch → `ollama run claude-*` silent engine swap (latent: no shipped caller passes `maxCostUsd`) | `core/test/regressions/s5-001-explicit-model-cost-routes-to-ollama.test.ts` |
| **S5-002** | Low | providers.ts | `classifyTool` returns inherited `Object.prototype` members for tool names like `toString`/`constructor` → event dropped at ingest | `core/test/regressions/s5-002-classifytool-prototype-pollution.test.ts` |
| **S5-003** | Low | ollama-client.ts | `listInstalled` throws raw `TypeError` (not `OllamaNetworkError`) on a malformed 200 `/api/tags` body → mislabeled 502 "unreachable" | `core/test/regressions/s5-003-listinstalled-malformed-body-typeerror.test.ts` |
| **S5-004** | Low (latent) | claude-args.ts | empty `allowedTools:[]` → dangling `--allowedTools` swallows the next flag (loses L0+L1 prompt injection); latent — shipped allowlists non-empty | `core/test/regressions/s5-004-empty-allowedtools-dangling-flag.test.ts` |
| **S6-002** | Low (latent) | bible.ts | section `slug` raw in `id`/`href`/`data-section` attrs (full breakout POSIX-only; `&` case cross-platform) | `core/test/regressions/s6-002-bible-slug-attr-unescaped.test.ts` |
| **S6-004** | Low (latent) | transcription.ts | transcript `text` unvalidated → `{}`→`{text:undefined}` (200 w/ no transcript), non-string relayed verbatim | `core/test/regressions/s6-004-transcript-text-unvalidated.test.ts` |
| **S8-002** | Low (latent) | web WorkflowChecklist.tsx | out-of-enum step `status` → unguarded `STATUS[…]` deref blank-screens the checklist (takes siblings); double-gated (kstore Zod enum + DB CHECK) → enum-drift forward-compat guard | `web/test/regressions/s8a-002-workflow-checklist-unknown-status-crash.test.tsx` |
| **S8-005** | Low | web verify.ts | `NaN` escapes `barPct`'s documented clamp (→ `width:NaN%`); non-finite ts → `"NaNd ago"`/`"Infinityd ago"` labels | `web/test/regressions/s8a-005-verify-nonfinite-inputs.test.ts` |

_S8-001, S8-003 fixed + promoted to the gating suite in reboot wave F1.W1._
_S1-018, S2-017, S7-001 fixed + promoted to gating in reboot wave F1.W2._
_S6-001, S6-003, S8-004 fixed + promoted to gating in reboot wave F1.W3._

### Notable non-fault concerns (documented; LOCK/characterization)
- **S2-001** (Med, docs-mismatch) — no approve/reject memory surface exists in code; gated reflection
  is enforced by absence. A future operator approval UI would have no double-approve guard.
- **S2-005** (Med) — the null-owner run bucket collapses distinct unknown run ids together (latent
  isolation gap; prod always injects a real K_RUN_ID).
- **S1-011/012** — createdAt tie order is unstable (no secondary key); negative LIMIT = unbounded.
- **S3-002** — advertised `additionalProperties:false` vs accept-and-strip mismatch.
- **S4 cross-cutting** (latent-risk, no red test) — verbatim task-title interpolation into the
  delegation prompt (no escaping); whitespace-only auth token accepted; empty-but-present asset
  degrades silently. See `findings/S4-prompt-delegation.md` "Cross-cutting notes".
- **S5-014** (Nit) — `run.tokensIn` ends as the result event's full input sum *incl. cache reads*, not
  the assistant fresh-input figure; pinned as LOCK, flagged for an operator decision on metric meaning.
- **S6-012** (Low) — bible has NO backup-on-recompile; the compiled HTML is a derived/gitignored
  artifact, so "restore" == recompile from the git-tracked `sections/`+`manifest.json` source of truth.
- **S7 characterization** — `parseCiRuns` accepts a float `databaseId`; a non-array `statusCheckRollup`
  reads as `'none'` (defensive, not strict). `rowToReport` silently drops a corrupt `score_breakdown`.
- **S8-011** (Low, observation) — `ContextMeter` would throw on `pressure.tokens === undefined`, but
  `tokens` is a non-optional `number` and the only producer (`contextPressure()`) always returns finite,
  so it's unreachable via the real call graph (one-line hardening opportunity, NOT codified).
- **S8-012** (Low, observation) — `chart.stackDays` doesn't throw on NaN/Infinity metric values but
  returns a poisoned `maxTotal: NaN` (lower priority than the ragged-points throw S8-004; not codified).
- **S8b E2E observations** (Med/Low/Nit, not gating tests) — **S8-E02** (Med): the core ships a complete
  `POST /api/transcribe` but **no web client ever calls it** (voice is backend-only, no UI affordance).
  **S8-E03** (Low): RUNBOOK selector cheatsheet is stale (`Settings` now enabled, `Tasks` removed).
  **S8-E04** (Low): `/api/status.voice` exists but Settings surfaces no Voice card. **S8-E01** (Low):
  populated workflow checklist can't be previewed token-free (no HTTP seed; only a real dispatch writes a
  `workflow_run`). **S8-E05** (Nit, LOCK): voice gate degrades cleanly (503 "voice disabled" when off).
  See `findings/S8-e2e-personas.md`.
- **T-EVAL prompt-quality findings** (Wave 9; observations, not vitest faults — a prompt weakness is a
  finding, not a quarantine test). **T-EVAL-001** (Med): K's tier/worker prompts are followed reliably by
  Opus but slip on Sonnet (the no-code secretary attempted code tools; L0 fabricated success / committed
  to main) — tier isolation rests on the `--allowedTools` allowlist, not prompt wording, on smaller
  models. **T-EVAL-002** (Low): L0/verification/spec-reviewer rules overlap Claude-Code's base alignment,
  so the K layer's measurable marginal lift is small (belt-and-suspenders); prompt-ROI is highest on the
  K-distinctive rules. **T-EVAL-003** (Low, test-infra): the headless Write/Edit denial confounds
  edit-dependent cases (implementer flailing, L0-06 false det-fail) — constant across variants, cancels
  in the discrimination delta. See `findings/T-EVAL-prompt-agent-skill.md`.
- **Test-infra (not an app finding)** — `graph.test.ts` had a pre-existing 20ms fire-and-forget race in
  its `POST /graph/build → ready` assertion; the heavier Batch C suite tipped it over, so it was
  hardened to poll-until-ready (behavior asserted unchanged). Committed with S7 (`8ca48d3`).

Full per-suite detail: `findings/S1-database-persistence.md`, `findings/S2-memory-work-tracking.md`,
`findings/S3-kstore-mcp.md`, `findings/S4-prompt-delegation.md`,
`findings/S5-supervisor-providers-routing.md`, `findings/S6-voice-bible.md`,
`findings/S7-verify-skills-github-graph.md`, `findings/S8-web-ui.md` (S8a pure-logic),
`findings/S8-e2e-personas.md` (S8b Playwright swarm), `findings/T-EVAL-prompt-agent-skill.md`
(Wave 9 eval harness — methodology, run `wave9` results, T-EVAL-001..003).

## Reconciliation rule

At consolidation: total `LOCK` rows == new passing tests committed; total `FAULT` rows == files in
`*/regressions/**`; every row links to a real test path. **T-EVAL (Wave 9) is exempt** — it is an
operator-triggered eval harness, not vitest; it contributes **0 LOCK / 0 FAULT**, and its deliverable is
the harness + frozen `baselines/` + `reports/wave9.*` + `findings/T-EVAL-prompt-agent-skill.md`.
