---
title: Agent Organization
icon: "❖"
status: active
updated: 2026-07-05
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
> self-wake-guarded — and, since P5.7, **governed** (org-relevant terminals only, a rolling-hour rate
> cap, and a kill switch — D-057; see *Autonomous wake* below). The K→Chief→lead delegation
> **dispatch** and named workflow definitions are **built** (D-046 → D-051, D-047), and the
> per-profile authority rows are **enforced at synthesis** (P5.7, D-054). **Still planned:** K as an
> autonomously-woken tier, wiring the real Google connectors, and memory layers B/C. Where a
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
  defaultModel: string | null  // explicit per-profile override (KNOWN_MODELS id), or null =
                               // "use the runtime claudeDefaultModel()" resolved at dispatch time
                               // (stored as the '' sentinel; seeds write no override — P5.7, D-056)
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

Authority is enforced at layers that compose, so a tier **cannot** reach a capability above its
station even if a prompt asks it to:

1. **Tier-scoped MCP servers.** Each tier mounts only the MCP servers its job needs.
   - the **kstore** server (**all tiers, BUILT**) — K's working store: work-item CRUD, lesson
     propose/list (gated reflection — memory layer A), and **workflow status-write**
     (`workflow_step_set` / `workflow_status_set`). Work-item visibility is **scope-dependent
     (P5.7, D-053)**: `scope='run'` (the default) keeps the original run-isolation — a run only
     sees its own tickets — while `'personal'` / `'org'` items are **durable operator-global**
     (they persist across sessions and runs; `run_id` is kept as provenance only). `scope='project'`
     is **REJECTED at the tool boundary** — project tickets are created via the projects API only
     (§04). Lessons stay run-scoped; the status-write tools self-gate to delegation-workflow runs.
   - the **logistics** server (**K, BUILT — P5.1a; de-run-scoped P5.7, D-053**) — K's logistics
     working store: notes, calendar events, and reminders (calendar/notes/scheduling), **STORAGE
     not execution** (`note_*` / `event_*` / `reminder_*`). Since P5.7 the store is
     **operator-durable** — reads and updates are no longer filtered by run (a note K took last
     week is still K's note today); `run_id` is recorded on insert as provenance only. No code, no
     project mutation, and no real-calendar side-effect — storing an event does not schedule it
     anywhere. (K's *tasks* stay the kstore `work_item_*` tools — logistics adds only the
     non-ticket logistics data, not a second task store.) The Google Calendar/Gmail/Drive
     connectors are **NOT wired** — see *Reused connectors* below.
   - the **mgmt** server (**Chief, BUILT — P5.2a**) — the Chief's management working store:
     `assign_lead` (hand a lead an objective), `pick_workflow`, `scope_projects`, `report` (a status
     write up the chain), and the read-only **`lead_list`** roster tool (**F-067, D-063** — the valid
     lead identifiers: id · name · discipline · role), plus the execution tool `dispatch_lead`
     (below) and — **P5.7, D-053 — two chief-READABLE tools, `assignment_list` / `report_list`**,
     durable **across Chief activations** (the enriched assignment list carries the dispatched lead
     run's live status), so a freshly-woken Chief can actually read the org state its charter tells
     it to review; writes keep run-scoped ownership. **`assign_lead` now VALIDATES the lead name**
     (F-067, D-063) via the SAME `resolveLeadProfileId` `dispatch_lead` uses and REJECTS an unknown
     lead (e.g. "engineering") at assign time — no more accepted-then-dangling assignment the
     dispatch step later rejects. Same shape as kstore/logistics — an **SDK-free** store layer
     (`core/src/mcp/mgmt.ts`, unit-tested) under a thin stdio glue (`mgmt-server.ts`), mounted on
     the chief tier and granted via `mcp__mgmt`. The storage tools stay **STORAGE, not
     execution** — assigning a lead does **not** dispatch it; the autonomous K→Chief→lead
     **dispatch** is BUILT (D-046 → D-051, below).
2. **The claude `--allowedTools` allowlist.** Coding tools — **Bash · Write · Edit · `Task`** — are
   present **only at the orchestrator (lead) tier**. K and the Chief simply do not have them on
   their allowlist, so neither can edit a file or spawn a coding subagent. (A mounted MCP server is
   also denied unless `mcp__<server>` is on the allowlist — so kstore is granted at every tier that
   mounts it.)

3. **The per-profile authority rows — ENFORCED since P5.7 (D-054).** `synthesizeConfigDir` now
   honors a profile's `allowed_tools` / `mcp_servers` / `skills` columns: a non-empty row is the
   operator's **narrowed** grant, mounted instead of the tier asset; an empty row falls back to the
   tier asset unchanged. The **tier is the CEILING** — a row can only narrow within its tier's
   allowlist/MCP template/bundle, never exceed it: an above-ceiling PATCH is rejected `400`
   (`authority.ts::assertTierCeiling`, typed `GrantError`), an unknown MCP server fails closed, and
   synthesis is **validate-before-mutate** — every check runs before any write, so a rejected
   profile leaves no partial config dir. Before P5.7 the editors were cosmetic (the row was stored
   but the synthesizer read tier assets only); now the stored grant and the run's actual mount are
   the same fact.

4. **Discovered capabilities widen the ceiling only by explicit opt-in (D-069/D-070,
   host-integration program).** `authority.ts::resolveEffectiveCeiling(tier)` = the tier's assets
   ∪ — only when the tier's bundle sets `allowDiscoveredSkills` / its MCP template sets
   `allowDiscoveredServers` (**orchestrator-only** true; chief/secretary false) — the
   operator-**enabled**+`ok` discovered assets, with the `allowedTools` ceiling widening in
   lockstep (`mcp__<server>` for each admitted server). It is the **one validator** behind the
   profile PATCH and both runtimes (claude synthesis and the ollama tool loop), so the stored
   grant and the run's actual mount can never drift. A **qualified key** (`user:…` / `project:…` /
   `plugin:…`) fails closed at PATCH when its asset is disabled, missing, or untrusted; bare names
   keep the legacy k-native semantics unchanged. **K-reserved server names**
   (`kstore` / `logistics` / `mgmt` / `gitnexus` — `authority.ts::K_NATIVE_SERVER_NAMES`) are
   refused at admission, so a host server can never impersonate a K server. The invariant stacks:
   **operator enablement is a precondition, tier opt-in is the ceiling, profile assignment
   narrows.** K and the Chief stay **read-only by design** here — discovered-capability assignment
   is a lead-tier + org-default surface only (their tiers don't set the flags, and their editors
   expose no picker).

> **"agent" (the concept) vs `Task` (the tool-id).** We keep **"agent"** as the org vocabulary
> everywhere — orchestrators, worker agents, subagents. The only thing that must read `Task` is the
> machine-matched `--allowedTools` entry: `Task` is the literal identifier of the subagent-spawning
> tool in the Claude Code CLI (verified against the binary), and the allowlist matches by exact
> string — `"Agent"` there would grant nothing, so an orchestrator could spawn no one.

**Reused connectors — the honest as-built.** K **does NOT mount the Google Calendar / Gmail /
Drive connectors** — its tier mounts **kstore + logistics only** (`agent-config/mcp/secretary.json`),
so K's "calendar" is the local logistics store, storage-not-execution. The Google connectors remain
**operator-side only** (the developer's own tooling, outside the managed-run boundary); wiring them
into K's tier is a planned follow-up, not a shipped capability. The Chief mounts **GitNexus MCP
read-only** for code intelligence without write authority. The harness's existing seams stay the
substrate underneath: the **EventBus** carries every tier's events, the **ModelRouter** picks each
run's provider/model, and the **GitHubProvider** remains the only path code reaches GitHub (leads
open PRs; nothing merges outside CI).

| Tier | MCP servers | Coding tools | Reused connectors | Default posture |
|------|-------------|--------------|-------------------|-----------------|
| **K** (secretary) | kstore · logistics(BUILT) | — none — | *none yet* — Google Calendar / Gmail / Drive **not wired** (planned) | answer + schedule + trigger Chief |
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

**As-built (P5.1c; K runtime redesigned W7a — D-062) — the "talk to K" front door.**
`POST /api/k/ask` activates K via `startAgentRun('k-secretary', { trigger: 'user-message', thread })`
and streams over the *existing* supervisor/EventBus/WS wire (no bespoke chat channel). A **durable K
thread** (`k_threads` / `k_thread_turns`) is the source of truth — it survives reload, and K's answers
are captured back to it at each turn boundary so a reseed stays coherent. Execution is a **resumable
one-shot** (D-062, superseding the old warm/fresh hybrid): each thread owns a stable Claude CLI
session — `--session-id <uuid>` on the FIRST ask (seeded with the full `renderSeed` transcript),
`--resume <id>` on every LATER ask sending **only the new message** — plus a stable per-thread config
dir + cwd under `<dataDir>/k-secretary/<threadId>/` (**no worktree** — K writes no code). Continuity
is a cheap cache-read of the resumed session, NOT a held warm process or a replayed transcript, so a
cold ask no longer re-pays the ~24k system-prompt + tool-schema envelope. The run **answers and
exits** (`done`) — it never parks at `awaiting_input` holding a live process (fixes the F-054
cost/park leak, subsumes H10); `cli_session_id` is persisted only on the first ask's successful
`done`, and undo (`POST /api/k/undo`) removes the dangling user turn so it is never replayed. This is
**GATED to `k-secretary`** — regular dispatch runs are byte-for-byte unchanged (fresh worktree,
ephemeral config, interactive HITL park). The route surfaced when composing is a deterministic
`routeForMessage` **preview** (client and server agree via `@k/shared`); K's runtime tool/hand-up
decision is authoritative.

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

**The wake governor (P5.7, D-057)** bounds the event path by CODE, not prompt — every wake is a
paid Chief activation that can itself dispatch a lead, so the wake → dispatch → lead-terminal →
wake cycle needed a hard cost bound:

- **Org-relevance filter** — only a terminal run that is org-relevant wakes the Chief: one owned by
  a **lead (orchestrator-tier) profile** or a **`trigger='delegation'`** activation. Plain runs,
  evals, skills, and K-chat terminals never do (and the self-wake guard still excludes the Chief's
  own runs).
- **Rolling-hour rate cap** — at most `chief_wake_max_per_hour` (`app_config`, default **6**) event
  wakes per rolling hour; a **suppressed wake creates no ledger row** (one warn per suppression
  streak), so the wake history stays the history of what actually fired.
- **Kill switch** — `chief_wake_events_enabled` (`'1'` default, read lazily per event so the
  operator can flip it at runtime) gates the event path only; the cron heartbeat is unaffected.

A **successful** wake logs one line (trigger / run / goal) so the loop is observable; debounced or
suppressed ticks stay quiet (F-089).

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
logistics/Q&A path (`route.escalates === false`) is **unchanged in routing** — K handles the message
itself as the resumable one-shot above (establish-or-`--resume` the thread's CLI session), never
delegating. The delegation check runs BEFORE the resumable path, so a hand-up is independent of K's
own session.

Three P5.7 refinements on the front door:

- **Logistics precedence (D-057).** `routeForMessage` evaluates the personal-logistics rules
  (reminders, notes, scheduling, list management) **before** the lead/engineering keyword rules, so
  "remind me to fix the fence" stays with K instead of auto-escalating on "fix". The trade-off is
  deliberate: a mixed-intent message **under-escalates by design** (a cheap re-ask) rather than
  spinning up the paid Chief machinery for a grocery note. And this classifier **is** the server's
  delegation decision — `askK` delegates on its `escalates` flag — not merely a preview; client and
  server agree because both call the same shared function.
- **Forced route.** `KAskBody.forceRoute` bypasses the classifier for an explicit target (the Chief
  or a named lead — every forceable target escalates by construction; forcing `logistics` is
  deliberately impossible). `routeForTarget` is the one shared mapping, so the composer's forced
  preview and the server's actual routing are the same computation.
- **Per-ask model override.** `KAskBody.model` (validated against the known-model registry at the
  route boundary) wins over the profile override, which wins over the runtime default (D-056). With
  the resumable one-shot (D-062) an override no longer forfeits continuity — there is no live process
  to keep, so the ask simply RESUMES the same session under the chosen model.

- **Report-back up the chain.** When the delegated Chief run reaches a **terminal** status, its
  outcome lands back on K's thread as a `k` turn — via `reportDelegationBack`, which rides the shared
  **run-lifecycle seam** (`trackSupervisedRun`: once-latch + race backstop) exactly like
  `startAgentRun`'s own tracking. The summary prefers the Chief's latest **mgmt `report`** (the status
  written up the chain, read run-scoped via `mgmtDb.listReportsByRun`), falling back to the run's own
  assistant text, then to a bare status line — so the operator always sees a result *where they
  asked*. It never touches the thread's `active_run_id` (that belongs to K's own run, a separate concern from a delegated run).
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
- **Fail-fast lead naming + injected roster (F-067, D-063).** So the Chief always names a REAL lead,
  the AUTO paths — the Chief's wake-goal seed, its no-hint delegation seed, and its charter — INJECT
  the five lead identifiers, and `lead_list` remains the authoritative roster to call before
  assigning. `resolveLeadProfileId` gates `assign_lead` (at assign time) and `dispatch_lead`
  identically, so an unknown lead like "engineering" is rejected once — never accepted-then-dangling.
- **Bound checklist (F-070, D-063).** A **project-scoped** lead dispatch binds a `workflow_runs` row +
  seeds its steps from the delegation workflow, so the lead's kstore status-write tools
  (`workflow_step_set` / `workflow_status_set`) RESOLVE against a real checklist instead of
  improvising. Seeding is isolated so a failure degrades to no-checklist without dropping the
  Chief/K report-back, and `finalizeWorkflowRun` reconciles lingering pending/in-progress steps to
  `blocked` so the checklist can't contradict a completed run.
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

**Scope.** loop-a landed the Chief→lead dispatch + report-back **seams** (verified in-process with a
mocked supervisor, no real token-spending dispatch). The one live-path gap it flagged — the dispatch
and its report-back ran only in the **stdio mgmt-server child**, so a real lead run's `agent_runs` row
stayed `running` forever and the report-back subscriber died with the child — is closed by **loop-b
b1** below. The two remaining pieces — the Chief→K report **continuation** (re-surfacing the lead's
report up through the Chief to the durable K thread) and the multi-tier org-tree DERIVATION render —
are closed by **loop-b b2** (D-051), completing exit-criterion #3.

### Main-process dispatch relay (BUILT — loop-b b1, D-050)

The dispatch now **runs for real** in the long-lived process. `dispatch_lead` is DECOUPLED into
*record* (child) + *execute* (main): because the mgmt-server child dies at the Chief's turn end, the
tool can only **record** the intent, never run the lead. So `dispatch_lead` resolves the lead
profile + workflow + seed prompt exactly as before, but instead of calling `startAgentRun` it inserts a
`pending` row into a **DB-backed `lead_dispatches` queue** (the child→main hand-off — an in-process
EventBus can't cross the process boundary; a shared SQLite file can).

- **The relay** (`core/src/lead-dispatch-relay.ts`, wired at boot in `index.ts` with a stop-fn on
  `onClose`, mirroring `startChiefWake`; default ON, `LEAD_DISPATCH_RELAY=0` opts out) polls the queue,
  **atomically claims** each pending row (`pending→dispatched` CAS, so an overlapping drain can't
  double-execute), then performs the real `startAgentRun(leadProfileId, { trigger:'delegation', goal,
  workflowId })` **in the main process** — so the run's `agent_runs` tracking-row lifecycle AND the
  lead→Chief report-back (`reportLeadOutcomeToChief`, re-subscribed on the **main** EventBus) both
  finalize in a process that stays up. `drainLeadDispatches()` is the directly unit-testable seam.
- **Partial-failure window closed** (loop-a carry-forward): once `startAgentRun` succeeds the lead run
  is LIVE, so the follow-up wiring (`setAssignmentLeadRun` + report-back) runs in an inner try/catch — a
  wiring throw can never lose the live run. A `startAgentRun` failure marks the intent `failed`, leaves
  the assignment link NULL (retryable), and degrades without crashing the loop; a null `chief_run_id`
  logs a skip rather than dropping the report silently.
- **Boot reconciliation** (`supervisor.ts::reconcileOrphanedActivations`, additive) is the safety net
  for a child that exited mid-dispatch: it finalizes `agent_runs` rows stuck `running` whose linked run
  is already terminal (done → `completed`, else `failed`), running BEFORE the blanket
  `reconcileStaleActivations` so a mid-dispatch-COMPLETED lead is recorded `completed`, not clobbered.
- **The Chief→lead link derivation is unchanged** — still `assignment.run_id` (parent) +
  `assignment.lead_run_id` (child) + the lead activation's `trigger='delegation'`, no new edge table;
  the `lead_dispatches` row is a transient execution queue, not the parent→child record.
- **Project-scoped dispatch (P5.7, D-055).** The relay resolves the assignment's `scope_projects`
  names through the **projects registry at EXECUTION time** and passes `projectId` + `cwd` into
  `startAgentRun`, so a scoped lead's worktree is created **in the scoped repo**, not K's own. Zero
  names keeps the K-repo default; the first name is authoritative (extras log a warning); an
  unresolvable name or a vanished `localPath` fails the dispatch cleanly via the **status-guarded**
  `markLeadDispatchFailed` (assignment link stays NULL → retryable). Any **post-claim throw
  mark-fails the intent immediately** — a claimed dispatch is never stranded `'dispatched'` waiting
  for the boot sweep.
- **Intents retire by LIVENESS DERIVATION (P5.7, D-060).** The queue has no success-terminal status
  — a completed intent stays `'dispatched'` forever — so "active" is **derived**, not stored:
  `getActiveLeadDispatchByAssignment` counts a `'dispatched'` row active only while it is genuinely
  in flight (the claim window, `lead_run_id` NULL, blocking fail-safe until the boot sweep — or its
  lead run still non-terminal). A completed intent therefore stops blocking, which **unwedges Chief
  re-dispatch of a completed assignment** and the operator **reassign** —
  `PATCH /api/chief/assignments/:id` moves an objective to another lead (`409` while the current
  lead run is live or a dispatch intent is in flight; `400` same-lead; clears the stale
  `lead_run_id` so the new lead stays dispatchable; files a durable mgmt audit report).

### Chief→K report continuation + whole-org tree (BUILT — loop-b b2, D-051)

The final hop closes the loop: a lead's outcome now flows all the way UP to K, and the whole chain is
rendered. Two gaps remained after b1, both fixed as pure wiring over existing links (no new table):

- **Chief→K report continuation.** `reportDelegationBack` (D-046) surfaces the Chief's outcome when the
  **Chief** run terminates — but a Chief's bounded activation can end BEFORE the lead it dispatched
  finishes, so that report can be PRE-lead. The continuation rides the **same lead-terminal signal** the
  lead→Chief mgmt report uses: in `lead-dispatch-relay.ts`, right after `reportLeadOutcomeToChief`, the
  relay also calls `k-thread.ts::continueLeadOutcomeToK(chiefRunId, leadRunId, lead)`. On the lead run's
  terminal (run-lifecycle seam, once-latched) it resolves whether the parent Chief run was itself a K
  delegation — a `k_thread_turns` row whose `run_id` = the Chief run (`kThreadsDb.getThreadIdByTurnRunId`),
  the exact K→Chief link `delegateToChief` recorded — and, if so, appends a `k` turn to that durable
  thread ("Chief (via <lead>) completed: <outcome>"), linked to the lead run so it stays traceable. It is
  a **no-op when the Chief woke autonomously** (no `k_thread_turns` row links it) — then the outcome stays
  in the Chief's mgmt store only. Deliberately independent of the lead→Chief report-back (each rides its
  own once-latched subscriber on the same terminal), mirroring `reportDelegationBack`'s shape.
- **The multi-tier org tree.** `web/src/lib/delegation.ts::fullOrgToDelegationTree` wraps the existing
  Chief subtree (`orgToDelegationTree`, unchanged) under two ancestor tiers — **user → K → Chief → lead
  → sub-agent** — reusing the same generic `DelegationTree` component (arbitrary depth). The K→Chief edge
  is derived from the existing links, no new table: `ChiefOrgPayload.kDelegations`
  (`agentRunsDb.countAgentRunsByProfileAndTrigger('chief','delegation')`) is the count of K hand-ups
  (`delegateToChief` is the only path that activates the Chief with `trigger='delegation'`; autonomous
  wakes use `schedule`/`event`). The ChiefPage now renders `fullOrgToDelegationTree(payload)`, so the
  whole chain is VISIBLE on the one batched `GET /api/chief/org` read.

With b2 the org loop is COMPLETE and observable end to end: K → Chief → lead → PR → report back to K,
every tier visible in one derived tree — exit-criterion #3.

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
unified, scoped task model (§04): **durable `personal` items** it owns for you (or org-wide `org`
items), persisting across sessions (D-053). K does **not** create `project`-scoped tickets — kstore
**rejects `scope='project'`** at the tool boundary; project tasks are created via the projects API
only (§04).
