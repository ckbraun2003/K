---
title: Glossary
icon: "📖"
status: stable
updated: 2026-07-24
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

**Position** — one of K, Chief, Orchestrator, or Worker; the org-model role, distinct from the enforcement tier.

**Commission** — a unit of accountability handed to a chief: objective, constraints, acceptance criteria, and allowance.

**Unit** — the scope of work an orchestrator owns end to end; one pipeline run or one directly delegated piece of work.

**Worker** — an ephemeral, tier-bounded subagent that does one job and hands back evidence; the only position with hands.

**Doctrine** — the four-layer rule system every member inherits: universal conduct and position procedure (locked and craft-free) plus domain policy and unit SOP (the user's to configure); you reshape the organization, never the locked layers.

**Gate class** — the category of a blocking decision: plan, review, merge/terminal, spend, destructive, or external.

**Resolver level** — whether a gate is orchestrator-resolved (internal, ledger-only) or escalated (the user's, delegable to a chief).

**The floor** — the class of actions never delegable by default: protected-branch merge, spend past cap, destructive ops, anything leaving the machine, credentials.

**Autonomy level** — L0 Attended through L3 Full; a preset over the gate-class matrix governing which escalated gates a chief may resolve.

**Escalation** — mandatory, never-delegable notification to the user, fired on locked doctrine triggers regardless of autonomy.

**Cohort** — the 1–5 agents an orchestrator runs on one objective, convergent (candidates then synthesis) or partitioned (disjoint parts then merge).

**Grounding artifact** — the output of a pipeline's Ground phase: what the bible and docs say, read before any work begins.

**Review artifact** — the review swarm's output, read by the orchestrator before the terminal gate and carried as loop context on a denied review.

**Standing job** — a shipped, system-triggered passive job a chief runs on a schedule with pre-authorized scope; never blocks, proposes what exceeds its scope.

**Commission thread** — the standing room per chief (user + K + chief) that is the durable record of that domain's work.

**Ledger** — the mandatory append-only write side of all reporting: per-unit for an orchestrator, per-goal for a chief.
