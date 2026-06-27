---
title: Vision
icon: "◈"
status: active
updated: 2026-06-27
---

A personal, self-hosted engineering harness, **K** — where you **direct an agent organization**
rather than operate a dashboard. You talk to **K**, a friendly secretary who handles logistics and
Q&A and hands real engineering work to a **Chief**, who staffs it to **staff-engineer leads** that
do the coding through GitHub pull requests, automated skills, and verification workflows. The
dashboard is the window into that organization — every action visible, replayable, and chartable.

The goal is not just a tool. It is a **persistent engineering org** that grows smarter over time
through per-agent memory, accumulated run data, knowledge graphs of your codebases, and a skill
testing/verification loop. (The organization — K, the Chief, the leads, their authority tiers and
memory — is **PLANNED for Phase 5**; see §03 Agent Organization and §09 Roadmap. The substrate it
rests on — supervisor, EventBus, ModelRouter, GitHubProvider, the verification loop — exists today.)

## Operating principles

1. **You direct an organization; K is the friendly face.** A single conversation with K is the entry
   point; K, the Chief, and the leads beneath them do the work. The org's structure is explicit and
   editable, not hidden plumbing.
2. **Visibility first.** Every agent action — at every tier — is an immutable event you can stream
   live, replay later, and chart over time. If the system did something, the dashboard can show it.
3. **Agents do the work; the harness keeps them honest.** Agents write code, open PRs, fix CI, and
   update docs — but deterministic CI gates merges, and verification agents audit the auditors.
4. **Bibles are living truth.** Every project carries detailed HTML documentation compiled from
   structured sections plus live system data. Documentation that drifts from reality is treated as a
   defect the verification loop catches.
5. **Seams over rewrites.** The monolith carries explicit seams (EventBus, ModelRouter,
   GitHubProvider) — and the agent tiers ride them — so future scale-out is a transport swap, not a
   redesign.

## What K is not

- Not a CI system — GitHub Actions is the CI runner; K authors, repairs, and reads it.
- Not a Git host — GitHub remains the source of truth for code; K works through it.
- Not a faceless automation queue — you converse with K like a colleague, but every engineering
  output still lands as a durable artifact, run record, or PR; the chat directs work, it never
  replaces the audit trail.

<!-- @live:stats -->
