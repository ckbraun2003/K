---
title: Agent Organization
icon: "❖"
status: active
updated: 2026-06-28
---

> **Status — PARTIALLY BUILT (Phase 5).** This section is the design of record for the agent
> organization. The **runtime substrate is now built**: the three authority tiers
> (`secretary | chief | orchestrator`), the per-tier charters + `--allowedTools` allowlists + MCP
> configs, the vendored skill set, the worker-agent definitions + per-tier bundles, the K-owned
> **kstore** working store (work-items, lessons, workflow status-write), and the synthesizer that
> mounts the right bundle + kstore per run all ship (decisions D-020 → D-027). **Still planned:** the
> multi-profile roster as DB rows (discipline leads), the `startAgentRun` generalization, the Chief
> and K as autonomously-woken tiers with their own management/logistics MCP services, and memory
> layers B/C. Where a capability already existed in the harness it is called out as **reused**.

K is re-framed from *an operator driving a dashboard* to **a user directing an agent organization**.
You talk to **K**; K and the agents beneath it do the engineering. The dashboard becomes the window
into that organization, not the thing you operate.

## The org

| Tier | Who | Job | Code authority |
|------|-----|-----|----------------|
| **K** | the friendly secretary — the home and face | logistics, Q&A, scheduling, notes, task lists; **routes** every request — handles logistics itself, or dispatches engineering to the Chief (or a specific lead), showing the route before send | **none** — K never writes code |
| **Chief** | the right-hand manager | runs the org continuously: woken by schedule/event/user, assigns leads to projects/goals, reports back to the user | **none** — delegates only |
| **Orchestrator leads** | staff-engineer specialists — Frontend · Backend · Systems · Security · Network | full coding inside their workflows; each is a charter + allowed skills/tools/MCPs + default model + memory; spawns worker agents via the `Task` tool | **full**, within charter |
| **Worker agents** | subagent **definitions** an orchestrator spawns — implementer · spec-reviewer · quality-reviewer · security-reviewer · debugger · planner | one bounded job per spawn, then gone; each carries its own tool scope (⊆ the orchestrator allowlist) — only the implementer writes; reviewers/debugger/planner are read-only | per-definition, ⊆ the tier |

A lead's discipline is a **capability bundle + charter, not a directory**. A "Frontend" lead is not
limited to a frontend folder — it is an orchestrator whose charter, skills, tools, and MCPs are
scoped to frontend work. Disciplines are configuration, so the roster grows by adding profiles, not
by changing code paths.

## One entity, three authority tiers

All three durable tiers — K, Chief, leads — are **one agent-profile entity** differentiated by an
**authority tier**: `secretary | chief | orchestrator`. The tier is the single field that gates
what a profile may touch. A profile is durable state: a **charter** (its prompt/role), a **memory**
(its accumulated lessons — see §04), allowed capabilities, and a default model.

```ts
AgentProfile {                 // PLANNED — Phase 5
  id: uuid
  name: string                 // "K", "Chief", "Frontend", …
  tier: 'secretary' | 'chief' | 'orchestrator'
  charter: string              // the role/system prompt for this profile
  defaultModel: string         // KNOWN_MODELS id
  allowedTools: string[]       // claude --allowedTools allowlist (tier-gated)
  mcpServers: string[]         // tier-scoped MCP servers this profile mounts
  skills: string[]             // skills this profile may trigger
  // memory is layered storage keyed by profile id (see §04)
}
```

> **Bridge that exists today.** The default profile is `default-orchestrator` (orchestrator tier) in
> `core/src/profiles.ts`, and the config synthesizer (§02) now reads that tier's **bundle**
> (`agent-config/bundles/<tier>.json`) to mount exactly its skills + worker-agent definitions
> (`agent-config/agents/*.md`) and rewrites the **kstore** MCP server into the run. The full
> multi-profile roster (discipline leads as DB rows) and the `startAgentRun` generalization of
> `startRun` are still planned.

## The control plane — authority is enforced, not advisory

Authority is enforced at two layers that compose, so a tier **cannot** reach a capability above its
station even if a prompt asks it to:

1. **Tier-scoped MCP servers.** Each tier mounts only the MCP servers its job needs.
   - the **kstore** server (**all tiers, BUILT**) — K's working store: work-item CRUD, lesson
     propose/list (gated reflection — memory layer A), and **workflow status-write**
     (`workflow_step_set` / `workflow_status_set`). Tools are run-scoped (a run only sees its own
     tickets/lessons); the status-write tools self-gate to delegation-workflow runs.
   - `logistics-mcp` (**K**, planned) — calendar/notes/task-list/scheduling; no code, no project mutation.
   - `mgmt-mcp` (**Chief**, planned) — assign-lead, pick-workflow, scope-projects, report-to-user; delegation, not coding.
2. **The claude `--allowedTools` allowlist.** Coding tools — **Bash · Write · Edit · `Task`** — are
   present **only at the orchestrator (lead) tier**. K and the Chief simply do not have them on
   their allowlist, so neither can edit a file or spawn a coding subagent. (A mounted MCP server is
   also denied unless `mcp__<server>` is on the allowlist — so kstore is granted at every tier that
   mounts it.)

> **"agent" (the concept) vs `Task` (the tool-id).** We keep **"agent"** as the org vocabulary
> everywhere — orchestrators, worker agents, subagents. The only thing that must read `Task` is the
> machine-matched `--allowedTools` entry: `Task` is the literal identifier of the subagent-spawning
> tool in the Claude Code CLI (verified against the binary), and the allowlist matches by exact
> string — `"Agent"` there would grant nothing, so an orchestrator could spawn no one.

**Reused connectors (not rebuilt).** K mounts the existing Google **Calendar / Gmail / Drive**
connectors for real logistics. The Chief mounts **GitNexus MCP read-only** for code intelligence
without write authority. The harness's existing seams stay the substrate underneath: the **EventBus**
carries every tier's events, the **ModelRouter** picks each run's provider/model, and the
**GitHubProvider** remains the only path code reaches GitHub (leads open PRs; nothing merges outside CI).

| Tier | MCP servers | Coding tools | Reused connectors | Default posture |
|------|-------------|--------------|-------------------|-----------------|
| **K** (secretary) | kstore · `logistics-mcp`(planned) | — none — | Google Calendar / Gmail / Drive | answer + schedule + trigger Chief |
| **Chief** (chief) | kstore · GitNexus(read) · `mgmt-mcp`(planned) | — none — | GitNexus MCP (read-only) | assign + report; wakes on schedule/event |
| **Leads** (orchestrator) | kstore · GitNexus (+ charter-scoped MCPs) | Bash · Write · Edit · `Task` | GitNexus MCP, project tooling | run workflows; PR-only, CI gates merges |

## Activation — persistent identity, ephemeral execution

Each tier is **durable** (charter + memory + conversation thread) but only ever **runs** as a
bounded activation. A single primitive activates any profile into a run:

```ts
startAgentRun(profileId, { trigger, goal | thread, projectId?, workflowId? })   // PLANNED — Phase 5
```

It seeds a run from the profile's charter + memory and dispatches it through the existing
supervisor/EventBus (it generalizes today's `startRun`). Three trigger kinds activate a profile:

- **user-message** — interactive, human-in-the-loop (you chatting with K, or with a lead).
- **schedule / event** — the **Phase-3 skills scheduler + event listener** (reused) wakes a tier
  autonomously (e.g. the Chief on a cron, a lead on `ci.failed`).
- **delegation** — one tier activates the next (K → Chief → lead → role subagent).

## The pipeline

```
user ──▶ K (secretary)
          │  pure logistics (calendar, notes, tasks, Q&A) → handled directly, no engineering tier
          │  ENGINEERING work only ──▶ Chief
          ▼
        Chief (chief)               also wakes autonomously on schedule/event
          │  picks orchestrator(s) + workflow + project(s), assigns the goal
          ▼
        Orchestrator lead (orchestrator)
          │  runs a workflow definition (see §04) in its own worktree
          ▼
        role subagents  (implementer → spec-review → quality-review)
          │
          ▼
        results bubble back up:  lead ──▶ Chief ──▶ K ──▶ user
```

K is the only tier the user speaks to by default. **The user states their intent to K; K routes it** —
to logistics it handles itself, to the **Chief** for engineering, or to a **specific lead** — and the
chosen route is **shown before dispatch** (one front door, see §08). It handles everything
non-engineering itself and escalates only real engineering work down the chain; the Chief chooses how
to staff it; a lead does the work through a workflow; and the outcome (a PR, a report, a verified
result) flows back up to the user through the same chain. K may also create **`work_items`** — the
unified, scoped task model (§04): `personal` items it owns for you, or `project`-scoped tickets it
adds to a project's list (so "**K can add to project tasks**" is preserved, without a second table).
