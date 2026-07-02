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
> run-lifecycle seam). **The Chief now wakes autonomously** (P5.2b, D-044): a scheduler tick or a
> subscribed run-completion event fires `startAgentRun('chief', …)`, debounced + already-running- +
> self-wake-guarded (see *Autonomous wake* below). **Still planned:** K as an autonomously-woken tier,
> the K→Chief→lead delegation **dispatch**, named workflow definitions, and memory layers B/C. Where a
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
> seam — rolling the tracking row back to `failed` on a dispatch failure. The **Chief autonomous wake
> loop is now built on this primitive** (P5.2b, D-044 — scheduler + event → `startAgentRun('chief')`);
> K's own wake loop and the K→Chief delegation dispatch remain planned.

> **Per-lead control plane surfaced (P5.3a).** The five discipline leads are now readable and editable
> as a first-class operator surface: `routes/orchestrators.ts` exposes a slim roster
> (`GET /api/orchestrators`), one-lead detail (`GET /api/orchestrators/:id`), and a per-lead authority
> `PATCH` for skills/tools/MCP/model. The PATCH delegates to `profiles.ts::updateProfile`, which
> re-resolves the charter's authority and runs the **fail-closed** mcp↔allowlist grant guard — so the
> edit surface can never mount an ungranted server (rejected `400`, row unchanged). A **tier/charter
> move is deliberately NOT patchable here** (it could flip a lead off `isLead` and out of its own
> management surface); authority editing means skills/tools/MCP/model only (D-043).

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
     lead. The Chief's **autonomous scheduler/event wake is BUILT (P5.2b)** (see *Autonomous wake*
     below); autonomous K→Chief→lead delegation **dispatch** is still **planned** (it touches K's
     routing — a later slice).
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

**As-built (P5.1c) — the "talk to K" front door.** `POST /api/k/ask` activates K via
`startAgentRun('k-secretary', { trigger: 'user-message', thread })` and streams over the *existing*
supervisor/EventBus/WS wire (no bespoke chat channel). A **durable K thread** (`k_threads` /
`k_thread_turns`) is the source of truth — it survives reload, and K's answers are captured back to
it at each turn boundary so a reseed stays coherent. Execution is ephemeral: while you keep chatting,
a **warm interactive session** (reusing the D-014 persistent-stdin loop) continues the *same* live
run via `sendInput`; when the thread is cold/idle a **fresh run** is started, seeded from the durable
thread. The route surfaced when composing is a deterministic `routeForMessage` **preview** (client
and server agree via `@k/shared`); K's runtime tool/hand-up decision is authoritative.

### Autonomous wake — the Chief wakes itself (BUILT — P5.2b, D-044)

The Chief no longer waits to be spoken to: **`core/src/chief-wake.ts`** wires the reused Phase-3
**node-cron scheduler** (a `*/15 * * * *` tick, `CHIEF_WAKE_CRON`) **and** the **EventBus**
(`onRunUpdate`, on a terminal run) straight into the existing `startAgentRun('chief', { trigger })`
primitive — it rebuilds neither the scheduler nor the activation path. A schedule tick fires a
`trigger:'schedule'` wake; a subscribed run-completion fires a `trigger:'event'` wake. `startChiefWake()`
is wired at boot in `index.ts` (returns a stop fn torn down on `onClose`; default ON, `CHIEF_WAKE=0`
opts out).

The wake is bounded by **two guards + a self-wake guard**, and a **failure-degrade**:

- **Min-interval debounce** (Guard A) — a burst of ticks/events collapses to one wake (the debounce
  clock is committed synchronously, before the dispatch await).
- **Already-running** (Guard B) — if a Chief run is already `running`, a new wake is skipped (one
  Chief activation at a time). A crash-orphaned `running` activation would otherwise lock this guard
  forever, so boot reconciliation (`reconcileStaleActivations`, `supervisor.ts`) sweeps stale
  `running` activations to `failed` — mirroring the existing `runs` boot sweep.
- **Self-wake guard** — the Chief's *own* run finishing does **not** re-wake the Chief, so no
  wake → run → complete → wake loop forms.
- **Failure-degrade** — a dispatch failure is recorded `failed` via the `startAgentRun` **rollback
  contract** and then *swallowed*, so a cron/event callback never crashes the loop.

Per **D-044**, a "Chief wake" is not a new table — it **reuses `agent_runs`**: a row with
`profile_id='chief'` and `trigger ∈ {schedule,event}`, whose columns already carry the four wake
facts (kind=`trigger`, time=`created_at`, resulting run=`run_id`, outcome=`status`). The Chief org
route already reads this history (`chiefWakes`), so the surface was wired before the wakes existed;
P5.2b just makes them exist. (K→Chief delegation dispatch was the deliberately-deferred next slice
— now built; see below.)

### K→Chief delegation + report-back (BUILT — D-046)

The up/down chain is now closed: an engineering request actually **flows K → Chief and reports
back**. In `core/src/k-thread.ts::askK`, once the durable user turn is recorded, the deterministic
route is consulted **before** the warm/cold branch: when `route.escalates` is true (the Chief, or a
named discipline lead), K **delegates instead of running the message itself** —
`startAgentRun('chief', { trigger: 'delegation', goal })`, where the goal is K's ask verbatim plus,
for a named-lead route, the discipline hint so the Chief can `assign_lead` the right lead. K's pure
logistics/Q&A path (`route.escalates === false`) is **unchanged** — it still continues a warm
interactive session via `sendInput` or starts a fresh seeded k-secretary run.

- **Report-back up the chain.** When the delegated Chief run reaches a **terminal** status, its
  outcome lands back on K's thread as a `k` turn — via `reportDelegationBack`, which rides the shared
  **run-lifecycle seam** (`trackSupervisedRun`: once-latch + race backstop) exactly like
  `startAgentRun`'s own tracking. The summary prefers the Chief's latest **mgmt `report`** (the status
  written up the chain, read run-scoped via `mgmtDb.listReportsByRun`), falling back to the run's own
  assistant text, then to a bare status line — so the operator always sees a result *where they
  asked*. It never touches the thread's `active_run_id` (that belongs to K's own warm session).
- **Traceability — no new table, no new column.** The delegation **is** the
  `startAgentRun('chief', { trigger:'delegation' })` row (`agent_runs.trigger='delegation'`,
  `run_id`=the Chief run). The parent→child link is recorded on the **existing `k_thread_turns.run_id`
  FK**: K links the user turn (and an acknowledgment "Routing to …" turn) to the delegated Chief run.
  So the K→Chief hop is derivable both ways — a thread's delegations are its turns whose `run_id`
  points at a `trigger='delegation'` agent_run; a Chief run's parent thread is the turn referencing
  it — with zero schema change.
- **Rollback-on-throw holds.** A dispatch failure propagates out of `askK` (the `agent_runs` row is
  rolled back to `failed` by `startAgentRun`'s contract, and no acknowledgment turn is written); the
  durable user turn stays, since the thread is the source of truth for what was asked.
- **Interaction with the wake loop.** The delegated Chief run finishing does **not** spuriously
  re-wake the Chief — `chief-wake.ts`'s self-wake guard already skips a terminal whose owning
  `agent_runs.profile_id === 'chief'`.

**Scope.** This slice is the **K→Chief hop + report-back** only. The Chief→lead `assign_lead` store
already exists (P5.2a); the downward **dispatch** hop that activates the lead is built next (below).

### Chief→lead dispatch + report-back (BUILT — loop-a, D-049)

The downward hop is now closed too: the Chief autonomously **dispatches** an orchestrator lead. A new
mgmt **execution** tool, `dispatch_lead` (`core/src/mcp/mgmt.ts`; the four earlier mgmt tools —
`assign_lead`/`pick_workflow`/`scope_projects`/`report` — stay **storage-only**), takes one of the
Chief run's assignments and activates its lead:

- **Resolve + seed from a workflow.** `core/src/chief-dispatch.ts::resolveLeadProfileId` maps the
  assignment's free-text `lead` (e.g. `Frontend`, `lead-backend`, `Backend lead`) to a lead profile
  id — by id, then name, then a normalized discipline slug — **gated by `isLeadProfile`** so K, the
  Chief, or the default orchestrator can never be dispatched as a lead. `resolveLeadWorkflow` resolves
  the assignment's chosen NamedWorkflow (default `code-wave`), and `buildLeadSeed` renders that
  workflow's `promptScaffold` via `renderWorkflowPrompt` — the **objective as the single checklist
  item** — then appends a **lead charter line** instructing the lead to deliver the batch and **open a
  PR** (never push to a default branch). The lead is activated with
  `startAgentRun(leadProfileId, { trigger: 'delegation', goal, workflowId })`.
- **Report-back up the chain.** On the lead run's **terminal**, `reportLeadOutcomeToChief` rides the
  same **run-lifecycle seam** (`trackSupervisedRun`) — the downward twin of `reportDelegationBack` —
  and files a mgmt `report` scoped to the **Chief's** run summarizing the lead's assistant text
  (capped) or a bare status line, so the Chief's next activation reads the outcome in its own store.
- **Traceability — one nullable column, no new table.** The parent→child link is
  `mgmt_assignments.lead_run_id` (the dispatched lead's run id; parent = `assignment.run_id`) plus the
  lead activation's `agent_runs.trigger='delegation'` — the exact mirror of K→Chief's
  `k_thread_turns.run_id` + trigger. So the whole tree (Chief run → assignment → lead run) is
  DB-derivable with zero schema drift.
- **Guards + rollback.** `dispatch_lead` rejects a **double-dispatch** (`lead_run_id` already set) and
  a **cross-run** assignment (ownership-scoped fetch); a dispatch throw leaves `lead_run_id` NULL
  (retryable) via `startAgentRun`'s failed-row rollback. The store logic stays SDK-free;
  `mgmt-server.ts` now `await`s the tool handler (async-tool support).

**Scope.** This is **loop-a** (the Chief→lead dispatch + report-back), landed as **seams verified
in-process with a mocked supervisor** (no real token-spending dispatch). **loop-b** — the Chief→K
report continuation / re-wake and the multi-tier org-tree DERIVATION render — is deferred (P5.6).
One live-path wiring is also deferred to the conductor's gated live smoke: because a Chief run invokes
`dispatch_lead` through the **stdio mgmt-server child**, today the lead dispatch + its report-back
subscriber are bound to that child's process/EventBus; moving the dispatch onto the long-lived **main
process** (so lead supervision, report-back, and WS streaming outlive the Chief's turn) is the
remaining wiring before the end-to-end autonomous loop runs for real.

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
