---
title: Glossary
icon: "📖"
status: stable
updated: 2026-07-10
---

# Glossary

Canonical definitions for the terms K's UI surfaces. Extracted at compile time into the
live tooltip component — edit here, then run `pnpm bible`.

**Wave** — one implementer plus separate spec and quality reviewers producing a single reviewable commit.

**Park** — a run paused awaiting the operator: `awaiting_input` (process alive on stdin) or `awaiting_plan` (process dead, resumable).

**Plan gate** — a dispatch that runs a plan turn, parks at `awaiting_plan`, and continues only after the operator approves the (optionally edited) plan.

**Lead** — the orchestrator profile a run was dispatched through; roll-ups group runs by their latest orchestrator activation.

**Recent actuals** — median and p90 of measured `$/run` over a recency window, scoped to the agent profile, then project, then global.

**Weight band** — a relative light/medium/heavy indicator of a capability's context cost, derived from token counts (never a price).

**Review-ready** — a finished project run that has reviewable changes (a checkpoint chain) and has not yet been reviewed.

**Run Narrative** — a per-run card whose deterministic goal, outcome, files, verification, and cost always render, plus up to three "generated" local-model Decisions and Risks bullets that are omitted when the model is unavailable.

**Org Timeline** — the org's activity history as one read-time union projection over run heads, review-ready notifications, verification results, and open PRs; a query, never a persisted feed table.

**HealthRubric** — the single canonical health-score rubric shared by every web surface: >=75 healthy, >=50 warn, else critical, null unknown.
