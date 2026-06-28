# K Rigorous Testing Campaign — repeatable workflow

This directory is the **durable, re-runnable** definition of K's rigorous testing campaign: a
multi-orchestrator agent pipeline that hunts edge cases, stress, and fault-injection across every
system, codifies confirmed concerns as committed tests, and documents every replicated concern.

> Full design rationale: the approved plan at `~/.claude/plans/read-and-analyze-the-purring-bentley.md`.
> This README is the operational runbook; the plan is the spec.

## Invariants (never violate)

1. **Green-CI invariant.** A *passing* edge/stress/characterization test lands in the gating suite
   (`core/test/**` or `web/test/**`). A test that codifies a **confirmed fault** is **red**, so it
   goes to the **non-gating quarantine** (`core/test/regressions/**` or `web/test/regressions/**`),
   linked to a finding id. It flips into the gating suite only when the operator fixes the fault.
2. **Replicate-then-record.** No concern is recorded until **two independent agents** (a prober and a
   separate validator) reproduce it. Every finding names both.
3. **Isolation.** Every agent/worktree gets its own `K_DATA_DIR`. Never share a SQLite file across
   parallel teams. (See the documented vitest shared-temp flake.)
4. **Document-only on app source.** The campaign creates files under `testing/`, `core/test/**`,
   `web/test/**`, and test-infra configs only. It **must not** edit `core/src/**`, `web/src/**`,
   `shared/src/**`, or `agent-config/**`. A needed source change is a *finding*, not an edit.
5. **Reviewed every wave.** Each suite's tests + findings pass spec-review + quality-review before the
   Director commits. The test author never reviews their own work.

## Pipeline roles

- **Test Director** — owns the campaign: branch/worktrees, dispatches Suite Orchestrators, aggregates
  findings into `ledger.md`, runs the review gate, commits one reviewable commit per wave, verifies CI.
- **Suite Orchestrator** (one per suite S1–S8 + T-EVAL) — runs the per-suite loop for its domain.
- **Prober / Validator / Test-Author** — adversarial probe → independent replication+classification →
  codify into tests.
- **spec-reviewer / quality-reviewer** — the standard delegation-loop review, every wave.

## The per-suite loop (re-run this for any suite)

1. **Scope** — read the suite charter (`suites.md`); map systems → files → behaviors → vectors.
2. **Probe** — adversarial agents produce concern candidates.
3. **Validate** — an independent agent reproduces each; drop the irreproducible; classify
   `LOCK` (current behavior correct → green test) vs `FAULT` (confirmed bug → red quarantine test).
4. **Codify** — write tests: `LOCK`→gating dir, `FAULT`→`*/regressions/**` linked to a finding id.
5. **Document** — write `findings/S<n>-<name>.md` (full schema below).
6. **Review** — spec-review + quality-review; fix findings.
7. **Commit** — Director commits; runs gating checks; confirms green; updates `ledger.md`.

## Finding schema (every row in `findings/S<n>-*.md`)

`id` · `system` · `severity` (Critical|High|Med|Low|Nit) · `category`
(Bug|Perf|Edge|Robustness|Docs-mismatch) · `surface` · `repro` · `expected` · `actual` ·
`evidence` · `classification` (LOCK|FAULT) · `prober` · `validator` · `test-path` · `status`
(open|validated|codified|quarantined).

## How to run the gating + quarantine + eval suites

```bash
# wipe shared temp DBs first (avoids the known vitest shared-data-dir flake)
node -e 'const os=require("os"),fs=require("fs"),p=require("path");for(const d of ["k-core-vitest-data","k-core-regressions-data"])fs.rmSync(p.join(os.tmpdir(),d),{recursive:true,force:true})'

pnpm typecheck            # shared + core + web
pnpm -r test              # GATING suite (must stay green)
pnpm test:regressions     # NON-GATING quarantine (red == an open confirmed fault; expected)
pnpm build                # core tsc + web tsc && vite build

# T-EVAL (Wave 9) — operator-/locally-triggered, spends real tokens:
#   see testing/eval/README.md
```

## Layout

```
testing/
  README.md           # this runbook
  suites.md           # the S1–S8 + T-EVAL charters + scope matrix (seed for "Scope")
  ledger.md           # campaign ledger: waves, statuses, finding index, baseline
  findings/           # per-suite V&V findings reports (S<n>-<name>.md)
  eval/               # the agent/skill/prompt eval harness (Wave 9)
core/test/regressions/ # non-gating quarantine — red tests for CONFIRMED core faults
web/test/regressions/  # non-gating quarantine — red tests for CONFIRMED web faults
core/test/**, web/test/** # NEW *passing* edge/stress tests (gate CI normally)
```
