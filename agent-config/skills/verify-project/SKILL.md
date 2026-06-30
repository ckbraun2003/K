---
name: verify-project
description: "Use to run the Layer-2 verification agent team for a registered project (bible §5). Fans out a CI auditor, test-coverage scout, PR reviewer, and doc-freshness checker; reports judgment findings and applies safe fixes via PR only — never direct push. Examples: \"run a deep verification on project X\", \"audit this project's CI and docs\", \"use the verify-project skill to check coverage and open PRs\""
---

# Verify Project (Layer 2)

## What It Does

Verification in K is **two-layer** (bible §5, decision D-004): machines check
what machines are good at; agents judge what requires judgment.

- **Layer 1 — deterministic CI + health score (owned by core).** The harness
  authors/repairs/reads GitHub Actions and computes the bible §5 health score
  (`score = 40·CI + 20·coverage-trend + 20·bible-freshness + 20·findings`). This
  is the synchronous `POST /api/projects/:id/verify` endpoint — fast, repeatable,
  no agent. It persists a `VerificationReport` and updates the project card.
- **Layer 2 — THIS skill (judgment).** A per-project agent team the harness
  dispatches as a **supervised run**. It fans out, audits what needs judgment,
  applies safe fixes (via PR, never direct push), and surfaces findings.

This skill is the JUDGMENT layer. The deterministic score/report is NOT this
skill's job — that already happened in Layer 1. This run adds findings a script
can't make.

## The Agent Team (bible §5)

| Agent | Audits | May fix |
|-------|--------|---------|
| **CI auditor** | workflows exist, pass, and cover **lint + typecheck + test + build** | repair / scaffold workflow files |
| **Test-coverage scout** | critical paths without tests; coverage trend vs. the last report | scaffold missing tests |
| **PR reviewer** | open PRs lacking review | post review comments |
| **Doc-freshness checker** | bible sections stale relative to recent commits; broken §3 invariants | update bible sections |

### CI auditor

Confirm `.github/workflows/` exists and that a workflow actually runs
**lint, typecheck, test, and build**. If a workflow is missing or incomplete,
scaffold/repair it. (Note: Layer 1 already scaffolds a *starter* `ci.yml` into
the working tree when none exists — see `fixesApplied`. The auditor's job is the
richer judgment: does the workflow cover all four stages, and is it green?)

### Test-coverage scout

Identify critical code paths with no test coverage and compare the coverage
trend against the previous verification report. Scaffold missing tests for the
highest-value gaps.

### PR reviewer

Find open PRs that lack a review and post substantive review comments.

### Doc-freshness checker

Flag bible sections that are stale relative to recent commits, and detect broken
bible §3 invariants (GitHub remote, `docs/bible/`, `.github/workflows/`). Update
bible sections where the drift is clear.

## Hard Rule — Fixes via PR, Never Direct Push

Every fix this team applies MUST land through a pull request. **Never push
directly to a default branch.** A fix without a PR is not a fix. (The supervisor
runs each agent in an isolated git worktree, reinforcing this.)

## How It's Triggered

The harness dispatches this skill as a supervised run scoped to the project
(`cwd = project.localPath`, `projectId = project.id`):

- **Manual** — the deep-verify path: `POST /api/projects/:id/verify` with body
  `{ "deep": true }`. The route returns the deterministic Layer-1 report
  immediately (200, unchanged shape) AND fire-and-forgets this skill as a normal
  run. The plain `POST .../verify` (no body, or `{ "deep": false }`) runs Layer 1
  only.
- **Scheduled** — per-project cron (default weekly).
- **Event-driven** — `ci.failed` from GitHubProvider polling.

## Output

Findings surface as a **normal run console** (the standard supervised-run event
stream / dashboard run view) — the same place any agent run appears.

> **Deferred (future increment):** wiring this agent's structured output back
> into a persisted `VerificationReport` (so judgment findings join the
> deterministic report and re-score the project) is explicitly NOT part of this
> increment. Today the deterministic report from Layer 1 is the persisted source
> of truth; this skill's findings are read from the run console.

## Notes

- The deterministic score lives in core (`core/src/verify.ts` →
  `runVerification`); the route is `core/src/routes/projects.ts`. Do not
  re-implement scoring here — read the score from the Layer-1 report.
- Health-score weights are documented in bible §5 (`05-verification-system.md`)
  so agents and operator agree on what "healthy" means.
- `fixesApplied` on a Layer-1 report uses the format
  `scaffolded CI workflow: .github/workflows/ci.yml` — a human-readable line per
  proposed change. Layer-1 scaffolds are uncommitted working-tree changes for
  operator review, not pushes.
