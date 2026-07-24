---
title: Vision
icon: "◈"
status: active
updated: 2026-07-24
---

A personal, self-hosted engineering harness, **K** — where you **direct an agent organization**
rather than operate a dashboard. You talk to **K**, a friendly secretary who handles logistics and
Q&A and hands real engineering work to a **Chief**, who staffs it to orchestrators whose workers
do the coding through GitHub pull requests, automated skills, and verification workflows. The
dashboard is the window into that organization — every action visible, replayable, and chartable.

The goal is not just a tool. It is a **persistent engineering org** that grows smarter over time
through per-agent memory, accumulated run data, knowledge graphs of your codebases, and a skill
testing/verification loop. (The organization — K, the Chief, its orchestrators and workers, their authority tiers and
memory — is **PLANNED for Phase 5**; see §03 Agent Organization and §09 Roadmap. The substrate it
rests on — supervisor, EventBus, ModelRouter, GitHubProvider, the verification loop — exists today.)

## Operating principles

1. **You direct an organization; K is its language interface, not its operator.** A single
   conversation with K is the entry point — K reads and routes but holds no authority and changes no
   state; the Chief, its orchestrators, and their workers do the work. The org's structure is explicit
   and editable, not hidden plumbing.
2. **Visibility first.** Nobody in the organization is resident — chiefs wake on events, orchestrators
   live only for their unit, workers are ephemeral — so the system reports rather than being watched;
   oversight granularity equals reporting granularity, streamed live, replayed later, and chartable
   over time.
3. **Agents do the work; the harness keeps them honest.** Agents write code, open PRs, fix CI, and
   update docs — but every handback is a typed exit carrying evidence-linked reports; deterministic CI
   gates merges, and verification agents audit the auditors.
4. **Doctrine is locked; the organization is yours.** Conduct — honesty, accountability, escalation —
   is fixed for every install; domains, orchestrators, jobs, and pipelines are yours to shape.
   Impressive by default, configurable within structure.
5. **Seams over rewrites.** The monolith carries explicit seams (EventBus, ModelRouter,
   GitHubProvider) — and the agent tiers ride them — so future scale-out is a transport swap, not a
   redesign.

Four positions carry this out — K, Chief, Orchestrator, and Worker — whose authorities and doctrine
are fixed by §03 (the constitution) and whose work modes, pipelines, and reporting shapes are set out
by §04 (how work flows).

## What K is not

- Not a CI system — GitHub Actions is the CI runner; K authors, repairs, and reads it.
- Not a Git host — GitHub remains the source of truth for code; K works through it.
- Not a faceless automation queue — you converse with K like a colleague, but every engineering
  output still lands as a durable artifact, run record, or PR; the chat directs work, it never
  replaces the audit trail.

<!-- @live:stats -->
