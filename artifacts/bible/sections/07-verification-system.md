---
title: Verification System
icon: "✓"
status: active
updated: 2026-07-04
---

Verification is **two-layer** (decision D-004): machines check what machines are good at; agents judge what requires judgment.

## Layer 1 — Deterministic CI (GitHub Actions)

Every project carries `.github/workflows/` running **lint · typecheck · test · build** on every push and PR. Free, standard, visible as green checks on GitHub, and runs even when the operator's machine is off.

The harness does not execute this layer — it **authors, repairs, and reads** it. Missing workflow? The verification skill scaffolds one matched to the project's stack. Broken workflow? The CI auditor fixes it and opens a PR.

## Layer 2 — the `verify-project` skill (agent team)

A per-project skill the harness dispatches as a supervised run. The team fans out, audits, applies safe fixes (via PR, never direct push), and files a report.

Under the Phase-5 agent organization (§03), this four-agent team is the canonical example of
**role subagents running under an orchestrator** — specifically the **Security lead** whose
workflow is "audit this project." The four auditors below are that workflow's role subagents; the
lead composes their findings into the report. Nothing about the deterministic spine changes — the
org framing just gives the team a home in the roster rather than being a free-floating skill.

| Role subagent | Audits | May fix |
|-------|--------|---------|
| **CI auditor** | workflows exist, pass, and cover lint+typecheck+test+build | repair/scaffold workflow files |
| **Test-coverage scout** | critical paths without tests; coverage trend vs. last report | scaffold missing tests |
| **PR reviewer** | open PRs lacking review | post review comments |
| **Doc-freshness checker** | bible sections stale relative to recent commits; broken invariants from §05 | update bible sections |

### Triggers

1. **Manual** — "run verification" button on the project card / workspace.
2. **Scheduled** — per-project cron (default weekly).
3. **Event-driven** — `ci.failed` from GitHubProvider polling.

### Output

```ts
VerificationReport {
  id: uuid
  projectId: uuid
  score: number              // 0–100 health score
  findings: Finding[]        // { severity: info|warn|critical, area, message }
  fixesApplied: string[]     // human-readable list, each backed by a PR/commit
  startedAt: number
  completedAt?: number
}
```

Reports persist to SQLite, stream to the dashboard's Verification tab, and the score lands on the project card.

## Health score

The score **PRORATES over only the dimensions it could actually MEASURE** (F-032 / D-064):

`score = round( Σ earned(measured) / Σ weight(measured) · 100 )` over four weighted dimensions —
**CI 40 · coverage-trend 20 · bible 20 · findings 20**.

An **unmeasured** dimension is **excluded from both the numerator and the denominator** — it neither helps nor hurts, and renders as a `null` bar (never a 0-bar or a full bar). If **no** dimension is measured the score is **null** — "insufficient signal" — **not 100**: a freshly-onboarded project no longer reads 100/100 off scaffold files that never ran. A **measured** dimension still demerits exactly as before:

- **CI (40):** latest default-branch run green = full marks; failing = 0; flaky (mixed last 5) = half. Unmeasured when there is no CI signal at all.
- **Coverage trend (20):** improving or stable (≥ prior within tolerance) = full marks; declining = half. **Unmeasured** (no `coverage-summary.json`) → excluded, never penalised. It is a **live signal** — see below.
- **Bible (20):** scored on **AUTHORED content**, not commit history — an authored bible (past the `BIBLE_SCAFFOLD_MARKER` sentinel), **even uncommitted** (D-028), earns full marks; a bare scaffold is **unmeasured**. Bible *quality* isn't machine-scorable, so a measured bible is simply full.
- **Findings (20):** no open critical = full; each open critical −10, each warn −2 (floor 0). Measured only once at least one of CI / coverage / bible is measured — a zero-signal scaffold carries no findings dimension either.

Because a score can now be absent, `verification_reports.score` and `score_breakdown` are **nullable** (a table rebuild, `SCHEMA_VERSION 4→5`), and every API + web consumer is null-safe. The formula is deliberately simple and documented here so agents and operator agree on what "healthy" means. Tune the weights by editing this section — the verification skill reads them from the bible.

## What shipped — the deterministic spine vs. the agent layer

This milestone delivered the deterministic Layer-1 spine end-to-end and authored the Layer-2 skill + deep dispatch. The split below records exactly what is computed by code today versus what is deferred to the agent layer.

### Deterministic spine (core owns it)

The health score and report are computed and persisted **deterministically** by `core/src/verify.ts` — no agent in the loop:

- `computeHealthScore` implements the §07 **prorated** formula above — it earns points per MEASURED dimension over the measured weight, returning the clamped score (or **null** when no dimension is measured) plus a per-factor `breakdown` (each factor `null` when unmeasured) for the UI bars.
- The pure auditors — **CI** (`auditCi` / `classifyCi`), **bible-freshness** (`auditBible`), and **invariants** (`auditInvariants`) — take already-gathered facts and emit `Finding[]`. `composeFindings` dedupes them so each root cause is counted once (CI/bible auditors own the missing-workflow / missing-bible criticals; only the GitHub-remote invariant is kept from `auditInvariants`, avoiding a double penalty).
- `runVerification` is the impure conductor: it gathers facts (cached GitHub CI status, `.github/workflows/` presence, the project's `coverage-summary.json`, and whether the bible is **authored** past the scaffold sentinel via `hasAuthoredBible` — which drives the *score* — while bible git-freshness via `git log` on the bible dir still feeds `auditBible`'s soft-staleness *finding*, not the score), scores with the pure core, persists a `VerificationReport` (including `score_breakdown`) and updates project health **atomically** in one SQLite transaction, then broadcasts a `verification_update` event.

Exposed via `POST /api/projects/:id/verify` (synchronous, authoritative) and `GET /api/projects/:id/verifications` (report history, newest first).

### Coverage trend — live signal

`runVerification` derives a **real** coverage trend per project: it reads the project's
`coverage/coverage-summary.json` (the istanbul/vitest/jest `json-summary` standard — `total.lines.pct`)
and compares it to the `coverage_pct` persisted on the project's previous report:

- **declining** (more than 0.1 pp below the prior reading) → coverage factor 0.5 (a real penalty).
- **improving / stable** (≥ prior within tolerance) → full marks.
- **first reading** (no prior measurement) → stable: a baseline is established, nothing to regress from.
- **unknown** (no `coverage-summary.json` for the project) → neutral / full marks — the signal stays
  inert for projects without coverage instrumentation, so it never penalizes a project for not emitting a
  coverage report; it activates the moment one appears.

Each report persists its measured `coveragePct`, so the trend is computed against real history. This
replaces the previous hardcoded `unknown` default — the 20-point coverage factor is now live.

### CI auditor — deterministic scaffold (uncommitted, not a push)

When a project has **no workflow**, verification scaffolds a starter `.github/workflows/ci.yml` into the working tree and records it in `fixesApplied` (e.g. `scaffolded CI workflow: .github/workflows/ci.yml`). This write is **UNCOMMITTED** — a proposed change left in the working tree for operator review. The score reflects the pre-fix state (missing CI → critical, CI component 0); the *next* verify observes the workflow. The §07 "fix via PR, never direct push" rule is preserved in spirit — nothing is committed or pushed. **Agent-opened PRs are the deferred next increment.**

### Agent layer — the `verify-project` skill

`POST /api/projects/:id/verify` with body `{ "deep": true }` returns the deterministic report immediately (unchanged shape) **and** additionally dispatches the `verify-project` skill as a supervised, fire-and-forget run (the four-agent team — CI auditor, test-coverage scout, PR reviewer, doc-freshness checker) scoped to the project. Its judgment findings surface as a **normal run console**, the same place any supervised run appears.

> **Deferred:** wiring the agent's structured output back into a persisted `VerificationReport` (so judgment findings re-score the project). This milestone the **deterministic engine owns the score and the report**; the skill's findings are read from the run console.

## Phase 3 — skill testing & routing outcomes

Verification extends in Phase 3 from *projects* to the harness's own *skills* and *routing*.

### Skill testing (eval-harness)

Skills in the registry (the Phase-3 Skill/Hook/Workflow registry — see Roadmap §09) can regress
silently. A **skill test** dispatches a
supervised run that invokes the external `everything-claude-code:eval-harness` skill against a
target skill's `source`, captures a pass/fail outcome, and compares it to that skill's prior
baseline. The harness does not reimplement evaluation — it reuses the eval-harness skill behind a
thin native layer.

```ts
SkillEval {
  id: uuid
  skillId: uuid
  runId: uuid | null       // the supervised eval run
  status: 'pass' | 'fail'
  regression: boolean      // was-pass, now-fail vs. the prior baseline
  createdAt: number
}
```

- Persisted in the `skill_evals` table; one row per test.
- `POST /api/skills/:id/test` dispatches the eval run; `GET /api/skills/:id/evals` returns history.
- A **regression** (the previous eval passed, this one failed) is flagged and surfaced as a badge
  on the Skills page. If the eval run can't be dispatched the call degrades cleanly — no crash.

### Routing outcomes (routing dashboard)

Every run already records its provider, model, cost, tokens, and status. The **routing dashboard**
aggregates that run-outcome data — cost, latency, and success rate by provider+model (and task
shape) — so the operator can see where spend goes and whether cheaper routing is paying off.
**Latency excludes** the time a run sat **parked** at `awaiting_input` (the shared `activeLatencyMs`
rule, W9a/F-082), so it measures processing time not operator think-time, and an operator-**killed**
run counts as **neither** a success nor a failure (excluded from the terminal denominator). The
same aggregates feed the `ModelRouter`'s cost-aware decisions (§02 Architecture). The view
reuses the existing stacked-SVG charts and `buildTimeseries`, and renders a sane empty state
before any runs exist. It is read-only insight today; **learned/automatic routing tuning is a
Phase 6 increment.**

## Behavioral eval subsystem — evals in the engine (Stabilization / F3, D-035)

Phase 3's `skill_evals` (above) is a *single self-review of a skill's prompt text*. The Stabilization
phase lifted the project's **rigorous behavioral eval harness** — previously out-of-band under
`testing/eval/`, never in `pnpm test` — **into the engine** as a DB-backed, dashboard-surfaced,
operator-triggerable subsystem under `core/src/eval/`. It evaluates the **current agentic system** (the L0
base prompt, the tier charters, the worker-agent definitions, skills) on real behavior, not prompt text.

**Methodology (ported verbatim).** For every `system × case × model × variant`, the runner dispatches a
confined `claude -p` in a disposable sandbox worktree, then grades two ways: a **deterministic CHECKS DSL**
(file / commit / tool / output assertions, each weighted, some critical) and a **fixed-model LLM judge**
against a per-system rubric. A **degraded-anti-prompt control** runs each case a second time with a
deliberately-weakened prompt; the **discrimination** metric confirms the real prompt outscores the degraded
one (a system that can't tell them apart isn't really being tested). Results aggregate into per-system
metrics + an overall report, and **baselines** freeze / compare with **regression flags**.

**Data model.** `eval_systems` (generalizes `skill_evals` to charters / agents / L0, not just skills),
`eval_cases`, `eval_runs`, `eval_results`, `eval_baselines` — seeded idempotently from the existing
`testing/eval/{systems.json,cases,rubrics,degraded,baselines}` (prompt / rubric / degraded stay
file-referenced by path). Dispatch is a **direct await**, NOT the F2 supervised-run lifecycle seam — the
synth-config `startRun` path always injects the real L0 + L1, which would fight the degraded control.

**Surface.** `POST /api/evals/run` writes an `eval_runs` row and an async runner streams `eval_results`;
report / results / compare GETs + baseline freeze. The **Evals** dashboard (§08) lists systems + runs (with
progress), a per-system pass-rate / discrimination / regression report, the raw results table, and a gated
**Run** button. Only *enabled* systems join a run (the runner's `loadSystemsFromDb` filters `enabled = 1`);
the dashboard list still shows disabled ones.

**Token-gating (the one spend path).** `startEvalRun`, `POST /api/evals/run`, **and** the runner all default
`dry: true` — a dry run fabricates results and never dispatches. A real (token-spending) run requires an
**explicit `dry: false`** at every layer; the dashboard's Run dialog defaults to dry and resets its opt-in on
every open. Everything else — building, seeding, the dashboard, all tests — runs at **zero spend**.

**Relationship to skill `/test`.** The older `skill_evals` + `POST /api/skills/:id/test` path is **unchanged**
this phase (rewiring it onto the behavioral subsystem is a deferred follow-on); the new subsystem stands
alongside it. **P5 extension:** it is built to add **DB-sourced `AgentProfile`s** as eval systems, so the
agent org can be evaluated as it comes online.

<!-- @live:recent-runs -->
