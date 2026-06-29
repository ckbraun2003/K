# K Rigorous Testing Campaign — Summary & Closeout

Branch `test/rigorous-campaign` (off `main`, not pushed). Director-run, multi-orchestrator. **10 waves,
one reviewable commit per wave, document-only on app source.** This file is the closeout; `README.md` is
the re-runnable runbook, `ledger.md` is the live record, `findings/` holds per-suite V&V detail.

## Headline result

| Metric | Wave-0 baseline | After campaign | Δ |
|--------|-----------------|----------------|---|
| Gating tests (green) | core 714 / web 254 = **968** | core **1011** / web **279** = **1290** | **+322 LOCK** |
| Gating files | core 59 / web 26 | core 93 / web 31 | +34 core / +5 web |
| Quarantine files (red-by-design) | 0 | **18** (13 core + 5 web) | +18 FAULT |
| Confirmed faults | — | **18** (2 High, 6 Med, 10 Low) | — |
| Eval harness (Wave 9) | — | 6 systems × 8 cases, 192 dispatches | 3 prompt findings |

**Gating stays GREEN; quarantine is RED by design** (28 core + 14 web test failures, +1 web green
sanity guard — the cron-DoS worker self-check). Re-verified from a clean tree at Wave-10 (see
Reconciliation). **Zero app-source edits across all 10 waves** — every source-affecting issue is a
quarantined finding, not a fix.

## Waves

| Wave | Suite | LOCK (new green) | FAULT | Key findings |
|------|-------|------------------|-------|--------------|
| 0 | Scaffold + baseline + quarantine harness | — | — | env-honoring vitest configs (additive), single-serial-fork runner |
| 1 | S1 Database & Persistence | 37 (7 files) | 1 | **S1-018** (Med) concurrent first-boot migrate ALTER race |
| 2 | S2 Memory & Work-Tracking | 20 (5 files) | 1 | **S2-017** (Med) dispatch-degrade reverts a `done` task |
| 3 | S3 MCP Working Store (kstore) | 26 (2 files) | 1 | **S3-001** (Low) omitted MCP `arguments` rejected for all-optional tools |
| 4 | S4 Prompt & Delegation Synthesis | 29 (6 files) | 1 | **S4-018** (Low) empty-taskIds validate-after-mutate orphan row |
| 5 | S5 Supervisor/Providers/Routing | 124 (6 files) | 4 | **S5-001..004** (Low) cost-route engine swap, proto-pollution classify, malformed-body TypeError, dangling `--allowedTools` |
| 6 | S6 Voice & Bible | 30 (4 files) | 4 | **S6-001** (Med) bible frontmatter XSS; **S6-003** (Med) non-audio MIME not 415'd |
| 7 | S7 Verify/Skills/GitHub/Graph | 31 (4 files) | 1 | **S7-001** (Med) one null graph node collapses the whole view |
| 8 | S8 Web/UI (S8a) + E2E swarm (S8b) | 25 (5 files) | 5 | **S8-001** (High) null event entry blanks projection; **S8-003** (High) cron range-expansion DoS |
| 9 | T-EVAL prompt/agent/skill eval harness | 0 (eval, not vitest) | 0 | **T-EVAL-001** (Med) tier prompts slip on Sonnet; allowlist is the backstop |
| 10 | Consolidate (this wave) | 322 total | 18 total | reconciliation + summary; no token spend |

Integration batches re-ran the *full* gate (not just per-suite) and caught two isolation defects the
isolated runs missed (S6 `@live:stats` assumed an empty shared DB; `graph.test.ts`'s pre-existing 20ms
fire-and-forget race) — both fixed test-side, no app source touched.

## Confirmed faults by severity (the 18 quarantined regressions)

**High (2)** — reachable, user-visible blast radius:
- **S8-001** — one `null` event entry throws → blanks the whole console/workflow projection (ungated
  stream-parser input). `web/test/regressions/s8a-001-*`.
- **S8-003** — `cron.ts` `*/0` step → unbounded loop → V8 OOM tab-crash; oversized range → multi-second
  main-thread freeze; reachable from the keystroke validator. `web/test/regressions/s8a-003-*`.

**Med (6)** — real but gated/multi-process/needs-corrupt-input:
- **S1-018** concurrent first-boot migrate ALTER race ("duplicate column name", multi-process).
- **S2-017** dispatch-degrade reverts a `done` work item to `open` (completion data loss).
- **S6-001** stored XSS via unescaped frontmatter in the compiled bible (latent — author/agent-controlled
  `.md` only, no HTTP/UI write path).
- **S6-003** non-audio MIME not 415'd → non-Buffer body reaches provider (gated behind voice-enabled).
- **S7-001** one null/non-object `nodes`/`links` entry collapses the graph view to empty+stale (needs an
  externally-corrupt artifact).
- **S8-004** `chart.ts::stackDays` throws `TypeError` on ragged/short series instead of degrading to 0
  (needs a malformed/partial metrics payload).

**Low (10)** — latent / defensive / needs malformed input: S3-001, S4-018, S5-001, S5-002, S5-003,
S5-004, S6-002, S6-004, S8-002, S8-005. (Full one-liners + test paths in `ledger.md` → "Confirmed
FAULTs".)

**Critical: 0.** No data-loss-on-the-happy-path or auth-bypass class fault was found.

## Non-fault findings (documented, not quarantined)

- **Characterization/LOCK observations** (current behavior is correct or unreachable, pinned as green
  tests or prose): S1-011/012 (unstable tie order, unbounded negative LIMIT), S2-001/005 (no
  double-approve guard; null-owner run-bucket collapse — latent), S3-002 (`additionalProperties` mismatch),
  S4 cross-cutting (verbatim task-title interpolation; whitespace token accepted), S5-014 (tokensIn incl.
  cache reads — metric-meaning decision), S6-012 (no bible backup-on-recompile; derived artifact),
  S7 characterization (lenient `parseCiRuns`), S8-011/012 (unreachable ContextMeter throw; poisoned
  `maxTotal: NaN`). See `ledger.md` → "Notable non-fault concerns".
- **S8b E2E (Playwright swarm)** — observations not gating tests: **S8-E02** (Med) core ships
  `POST /api/transcribe` but no web client calls it; S8-E03/04 stale RUNBOOK / missing Voice card; S8-E05
  voice gate degrades cleanly. See `findings/S8-e2e-personas.md`.
- **T-EVAL prompt-quality** (Wave 9; prompt weakness = finding, not a vitest fault): **T-EVAL-001** (Med)
  K's tier/worker prompts are followed by Opus but slip on Sonnet → the `--allowedTools` allowlist (not
  the prompt) is the real tier-isolation backstop on smaller models (defense-in-depth validated);
  **T-EVAL-002** (Low) L0/verification/spec-reviewer overlap base-CC alignment → small marginal lift;
  **T-EVAL-003** (Low, test-infra) headless Write/Edit denial confounds edit-cases (constant across
  variants → cancels in the discrimination delta). See `findings/T-EVAL-prompt-agent-skill.md`.

## Reconciliation (Wave 10, re-run from a clean tree)

- **LOCK = 322.** core 1011 − 714 = +297 across +34 files; web 279 − 254 = +25 across +5 files. Sum of
  the wave-table LOCK column == 322. (Wave-10 correction: S1/S2/S3 cells had been logged at their
  *finding* counts 23/16/10; the actual vitest *case* counts are **37/20/26**, confirmed by re-run. The
  integration-note running totals — 797 → 950 → 1011 — were always correct.)
- **FAULT = 18.** 18 wave-table FAULT rows == 18 files in `core/test/regressions/**` (13) +
  `web/test/regressions/**` (5); every row links to a real, currently-RED test path.
- **T-EVAL exempt** — operator-triggered eval, not in `pnpm -r test` → 0 LOCK / 0 FAULT.
- **Document-only HELD** — zero drift in `core/src`, `web/src`, `shared/src`, `agent-config/**`, or any
  vitest config beyond the Wave-0 additive env-honoring change.

Verify (any time):
```bash
node -e 'const os=require("os"),fs=require("fs"),p=require("path");for(const d of ["k-core-vitest-data","k-core-regressions-data"])fs.rmSync(p.join(os.tmpdir(),d),{recursive:true,force:true})'
pnpm -r test            # expect core 1011 / web 279 GREEN
pnpm test:regressions   # expect 13 core + 5 web files RED (28 + 14 fail, +1 web green sanity)
```

## The repeatable pipeline (record)

This campaign is a **re-runnable workflow**, not a one-off. To reproduce on any K checkout, follow
`testing/README.md` (the runbook) seeded by `testing/suites.md` (the S1–S8 + T-EVAL charters):

- **Roles:** Test Director (branch/worktrees, dispatch, ledger, review gate, per-wave commit, CI verify)
  → Suite Orchestrators (one per suite) → Prober / Validator / Test-Author sub-agents → spec-reviewer +
  quality-reviewer every wave (author never reviews own work).
- **Per-suite loop:** Scope → Probe (adversarial) → Validate (independent replication; drop the
  irreproducible) → classify **LOCK** (correct → green gating test) vs **FAULT** (confirmed bug → red
  quarantine test) → Codify → Document (`findings/S<n>-*.md`) → Review → Commit.
- **Invariants enforced (all held):** (1) Green-CI — passing tests gate, confirmed faults quarantine
  red; (2) Replicate-then-record — two independent agents per finding; (3) Isolation — per-agent
  `K_DATA_DIR` (never share a SQLite file; see the documented shared-temp flake); (4) Document-only on
  app source; (5) Reviewed every wave.
- **Eval harness (Wave 9, `testing/eval/`)** — the one sanctioned real-token-spend lane: dispatches K's
  real prompts/charters/skills via `claude -p --append-system-prompt-file` in a confined disposable
  worktree (tools-enabled, `acceptEdits`, `--allowedTools` tier-enforced, no bypass), graded
  deterministically + by a fixed-Opus judge against frozen `baselines/` with a degraded-anti-prompt
  discrimination control. Re-run: `testing/eval/README.md`.

**Operator next step:** the 18 quarantined faults await triage/fix. Fixing a fault flips its red test
green; **move it from `*/regressions/**` into the gating suite** and drop its FAULT row — the quarantine
config (`vitest.regressions.config.ts`) and the ledger reconciliation rule keep the two suites honest.
