---
title: Verification System
icon: "✓"
status: active
updated: 2026-06-27
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

`score = 40·CI + 20·coverage-trend + 20·bible-freshness + 20·findings`

- **CI (40):** latest default-branch run green = full marks; failing = 0; flaky (mixed last 5) = half.
- **Coverage trend (20):** improving or stable ≥ baseline = full; declining = proportional (half). `unknown` — today's default, since no coverage signal is wired (see below) — scores as **full marks / neutral (no penalty)**.
- **Bible freshness (20):** all sections updated within 30 days of last significant commit = full.
- **Findings (20):** no open critical = full; each open critical −10, each warn −2 (floor 0).

The formula is deliberately simple and documented here so agents and operator agree on what "healthy" means. Tune it by editing this section — the verification skill reads its weights from the bible.

## What shipped — the deterministic spine vs. the agent layer

This milestone delivered the deterministic Layer-1 spine end-to-end and authored the Layer-2 skill + deep dispatch. The split below records exactly what is computed by code today versus what is deferred to the agent layer.

### Deterministic spine (core owns it)

The health score and report are computed and persisted **deterministically** by `core/src/verify.ts` — no agent in the loop:

- `computeHealthScore` implements the exact §07 formula above (`40·CI + 20·coverage-trend + 20·bible-freshness + 20·findings`), returning the clamped score plus a per-factor `breakdown` for the UI bars.
- The pure auditors — **CI** (`auditCi` / `classifyCi`), **bible-freshness** (`auditBible`), and **invariants** (`auditInvariants`) — take already-gathered facts and emit `Finding[]`. `composeFindings` dedupes them so each root cause is counted once (CI/bible auditors own the missing-workflow / missing-bible criticals; only the GitHub-remote invariant is kept from `auditInvariants`, avoiding a double penalty).
- `runVerification` is the impure conductor: it gathers facts (cached GitHub CI status, `.github/workflows/` presence, bible git-freshness via `git log` on the bible dir), scores with the pure core, persists a `VerificationReport` (including `score_breakdown`) and updates project health **atomically** in one SQLite transaction, then broadcasts a `verification_update` event.

Exposed via `POST /api/projects/:id/verify` (synchronous, authoritative) and `GET /api/projects/:id/verifications` (report history, newest first).

### Coverage trend = neutral today

There is **no coverage signal wired yet**, so `runVerification` defaults the coverage trend to `unknown`, which scores as neutral (full marks, no penalty). This is documented so operator and agents agree that today's score is effectively weighted on **CI + bible-freshness + findings**, and coverage stays neutral until an agent layer supplies a real trend.

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
shape) — so the operator can see where spend goes and whether cheaper routing is paying off. The
same aggregates feed the `ModelRouter`'s cost-aware decisions (§02 Architecture). The view
reuses the existing stacked-SVG charts and `buildTimeseries`, and renders a sane empty state
before any runs exist. It is read-only insight today; **learned/automatic routing tuning is a
Phase 6 increment.**

<!-- @live:recent-runs -->
