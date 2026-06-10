---
title: Vision
icon: "◈"
status: stable
updated: 2026-06-10
---

A personal, self-hosted **Jarvis** — a single entry point for directing AI agents to perform real engineering work across a fleet of projects: managing tickets and goals, contributing code through GitHub pull requests, running automated skills and verification workflows, and making all of it visible through a high-clarity dashboard.

The goal is not just a tool. It is a **persistent engineering co-pilot** that grows smarter over time through accumulated run data, knowledge graphs of your codebases, and a skill testing/verification loop.

## Operating principles

1. **Visibility first.** Every agent action is an immutable event you can stream live, replay later, and chart over time. If the system did something, the dashboard can show it.
2. **Agents do the work; the harness keeps them honest.** Agents write code, open PRs, fix CI, and update docs — but deterministic CI gates merges, and verification agents audit the auditors.
3. **Bibles are living truth.** Every project carries detailed HTML documentation compiled from structured sections plus live system data. Documentation that drifts from reality is treated as a defect the verification loop catches.
4. **Seams over rewrites.** The monolith carries explicit seams (EventBus, ModelRouter, GitHubProvider) so future scale-out is a transport swap, not a redesign.
5. **One operator, zero ceremony.** Self-hosted, single-user, no infrastructure beyond Node + SQLite + the `gh` CLI.

## What Jarvis is not

- Not a CI system — GitHub Actions is the CI runner; Jarvis authors, repairs, and reads it.
- Not a Git host — GitHub remains the source of truth for code; Jarvis works through it.
- Not a chat app — conversations exist to dispatch and supervise work, and every output lands as a durable artifact, run record, or PR.

<!-- @live:stats -->
