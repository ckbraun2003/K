---
title: Agent Organization
icon: "❖"
status: active
updated: 2026-07-01
---

> **Status — PARTIALLY BUILT (Phase 5).** This section is the design of record for the agent
> organization. The **runtime substrate is now built**: the three authority tiers
> (`secretary | chief | orchestrator`), the per-tier charters + `--allowedTools` allowlists + MCP
> configs, the vendored skill set, the worker-agent definitions + per-tier bundles, the K-owned
> **kstore** working store (work-items, lessons, workflow status-write), and the synthesizer that
> mounts the right bundle + kstore per run all ship (decisions D-020 → D-027). **P5.0 (foundation)
> now ships too** (D-037): the DB-backed **`agent_profiles`** registry seeded with the eight durable
> profiles (K · Chief · the default orchestrator · the five discipline leads), **`authority.ts`**
> (tier → allowed tools/skills/MCPs, with the fail-closed mcp↔allowlist grant guard), and the
> **`startAgentRun(profileId, …)`** activation primitive (tracked in `agent_runs`, riding the shared
> run-lifecycle seam). **Still planned:** the Chief and K as autonomously-woken tiers with their own
> management/logistics MCP services, named workflow definitions, and memory layers B/C. Where a
> capability already existed in the harness it is called out as **reused**.

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
AgentProfile {                 // BUILT (P5.0) — @k/shared AgentProfileSchema + core/src/profiles.ts
  id: string
  name: string                 // "K", "Chief", "Frontend", …
  tier: 'secretary' | 'chief' | 'orchestrator'
  charter: 'secretary' | 'chief' | 'orchestrator'  // charter-asset BASENAME (=== tier for the
                               // durable tiers); the charter PROMPT lives in
                               // agent-config/tiers/<charter>.charter.md, loaded by the synthesizer
  defaultModel: string         // KNOWN_MODELS id (env fallback preserved for the seed)
  allowedTools: string[]       // claude --allowedTools allowlist (tier-gated, resolved by authority.ts)
  mcpServers: string[]         // tier-scoped MCP servers this profile mounts
  skills: string[]             // skills this profile mounts
  // memory is layered storage keyed by profile id (see §04)
}
```

> **What ships today (P5.0).** `core/src/profiles.ts` is a DB-backed registry over `agent_profiles`
> (`getProfile`/`listProfiles`/`createProfile`/`updateProfile` + `seedProfiles`), seeded at boot with
> the eight durable profiles; `DEFAULT_PROFILE` (orchestrator) remains the in-memory fallback the
> supervisor uses when a run is dispatched without a resolved profile. `authority.ts` resolves a
> tier's `{allowedTools, mcpServers, skills}` from the same `agent-config/{allowlists,mcp,bundles}`
> assets the synthesizer (§02) reads — so a seeded profile's grant matches exactly what its run will
> mount — and runs the fail-closed mcp↔allowlist grant guard. `startAgentRun` (`core/src/agent-runs.ts`)
> generalizes `startRun`: it resolves the named profile, dispatches the run under THAT profile's tier
> (its charter/allowlist/MCP/skills), tracks it in `agent_runs`, and rides the shared run-lifecycle
> seam — rolling the tracking row back to `failed` on a dispatch failure. Still planned: the Chief/K
> autonomous wake loops and their logistics/management MCP services.

## The control plane — authority is enforced, not advisory

Authority is enforced at two layers that compose, so a tier **cannot** reach a capability above its
station even if a prompt asks it to:

1. **Tier-scoped MCP servers.** Each tier mounts only the MCP servers its job needs.
   - the **kstore** server (**all tiers, BUILT**) — K's working store: work-item CRUD, lesson
     propose/list (gated reflection — memory layer A), and **workflow status-write**
     (`workflow_step_set` / `workflow_status_set`). Tools are run-scoped (a run only sees its own
     tickets/lessons); the status-write tools self-gate to delegation-workflow runs.
   - the **logistics** server (**K, BUILT — P5.1a**) — K's logistics working store: notes,
     calendar events, and reminders (calendar/notes/scheduling), **STORAGE not execution** and
     **run-scoped** exactly like kstore (`note_*` / `event_*` / `reminder_*`; a run reads/mutates
     only its own rows). No code, no project mutation, and no real-calendar side-effect — storing an
     event does not schedule it anywhere. (K's *tasks* stay the run-scoped kstore `work_item_*`
     tools — logistics adds only the non-ticket logistics data, not a second task store.) Reusing
     the Google Calendar/Gmail/Drive connectors for real-world logistics remains Phase 5.
   - the **mgmt** server (**Chief, BUILT — P5.2a**) — the Chief's management working store:
     `assign_lead` (hand a lead an objective), `pick_workflow`, `scope_projects`, and `report` (a
     status write up the chain). Same shape as kstore/logistics — an **SDK-free** store layer
     (`core/src/mcp/mgmt.ts`, unit-tested) under a thin stdio glue (`mgmt-server.ts`), **run-scoped**
     (a run reads/mutates only its own assignments), mounted on the chief tier and granted via
     `mcp__mgmt`. It is **STORAGE, not execution** — assigning a lead here does **not** dispatch that
     lead. Autonomous K→Chief→lead delegation and the scheduler wake are **planned (P5.2b)**.
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
| **K** (secretary) | kstore · logistics(BUILT) | — none — | Google Calendar / Gmail / Drive | answer + schedule + trigger Chief |
| **Chief** (chief) | kstore · GitNexus(read) · mgmt(BUILT) | — none — | GitNexus MCP (read-only) | assign + report; wakes on schedule/event |
| **Leads** (orchestrator) | kstore · GitNexus (+ charter-scoped MCPs) | Bash · Write · Edit · `Task` | GitNexus MCP, project tooling | run workflows; PR-only, CI gates merges |

## Activation — persistent identity, ephemeral execution

Each tier is **durable** (charter + memory + conversation thread) but only ever **runs** as a
bounded activation. A single primitive activates any profile into a run:

```ts
startAgentRun(profileId, { trigger, goal | thread, projectId?, workflowId? })   // BUILT (P5.0)
```

It seeds a run from the profile (its tier's charter + allowlist + MCP + skills) and dispatches it
through the existing supervisor/EventBus (it generalizes today's `startRun`). Three trigger kinds
activate a profile:

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
