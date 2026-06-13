---
title: Verification System
icon: "✓"
status: active
updated: 2026-06-10
---

Verification is **two-layer** (decision D-004): machines check what machines are good at; agents judge what requires judgment.

## Layer 1 — Deterministic CI (GitHub Actions)

Every project carries `.github/workflows/` running **lint · typecheck · test · build** on every push and PR. Free, standard, visible as green checks on GitHub, and runs even when the operator's machine is off.

The harness does not execute this layer — it **authors, repairs, and reads** it. Missing workflow? The verification skill scaffolds one matched to the project's stack. Broken workflow? The CI auditor fixes it and opens a PR.

## Layer 2 — the `verify-project` skill (agent team)

A per-project skill the harness dispatches as a supervised run. The team fans out, audits, applies safe fixes (via PR, never direct push), and files a report.

| Agent | Audits | May fix |
|-------|--------|---------|
| **CI auditor** | workflows exist, pass, and cover lint+typecheck+test+build | repair/scaffold workflow files |
| **Test-coverage scout** | critical paths without tests; coverage trend vs. last report | scaffold missing tests |
| **PR reviewer** | open PRs lacking review | post review comments |
| **Doc-freshness checker** | bible sections stale relative to recent commits; broken invariants from section 3 | update bible sections |

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
- **Coverage trend (20):** improving or stable ≥ baseline = full; declining = proportional.
- **Bible freshness (20):** all sections updated within 30 days of last significant commit = full.
- **Findings (20):** no open critical = full; each open critical −10, each warn −2 (floor 0).

The formula is deliberately simple and documented here so agents and operator agree on what "healthy" means. Tune it by editing this section — the verification skill reads its weights from the bible.

<!-- @live:recent-runs -->
