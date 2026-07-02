---
title: Workflows & Memory
icon: "⟲"
status: active
updated: 2026-07-01
---

> **Status — partially BUILT (Phase 5).** The harness has one hardcoded delegation loop
> (`core/src/workflows.ts`), now extended so the orchestrator **reports progress** through the kstore
> status-write tools. **Memory layer A is built as a TOOL, not a file**: managed agents propose
> lessons through kstore `lesson_propose` (gated, held pending) into the `agent_memory` table —
> `tasks/lessons.md` is a **home-development-only** tracker, never written by a managed run. Work
> items are likewise a **tool + table** (kstore `work_item_*`, the `work_items` table). **Still
> planned:** named **workflow definitions** beyond the single loop, memory layers B/C (retrieval/
> weighting), and the unified `scope`-discriminated work-item model (decisions D-022/D-026; the
> shipped `work_items` is run-scoped — see below).

A lead does work by **running a workflow** and gets smarter over time through **memory**. Both are
configuration, not new engines — the substrate is the supervisor/EventBus already in place.

## Workflow definitions

Today, `workflows.ts` carries a single, hardcoded loop: `buildDelegationPrompt(tasks)` renders a
selection of todos as a checklist and instructs one supervised controller run to act out the
delegation loop in its own worktree, producing one reviewable PR (decision D-012). That loop is
**prose methodology** the orchestrator carries out internally — it is not a multi-run engine.

Phase 5 generalizes that single loop into **named workflow definitions** a lead selects per goal. A
definition is a small declarative record — its role sequence, the prompt scaffold, and a scope flag —
that `startAgentRun(profileId, { workflowId, … })` seeds into a run:

```ts
NamedWorkflow {                 // BUILT — P5.3b (generalizes today's single buildDelegationPrompt)
  id: uuid                      // pinned for the seeds: 'code-wave' | 'investigate' | 'refactor'
  name: string                 // "Code wave" (the first), "Investigate", "Refactor", …
  roles: WorkflowRole[]        // the role-subagent sequence (e.g. implementer → spec-review → quality-review)
  promptScaffold: string       // how the goal + roles are rendered into the controller prompt ({{CHECKLIST}} token)
  crossProject: boolean        // may the run touch more than one project? (flag lands; multi-project EXECUTION deferred)
}
```

> **Named `NamedWorkflow`, NOT `WorkflowDefinition` (D-047).** The persisted DB entity is
> `NamedWorkflow` (table `workflow_definitions`) — deliberately distinct from the existing
> `@k/shared` `WorkflowDefinition` (roles + edges), which is the read-only **diagram** type and is
> left untouched.

- **`implement+review` is the first definition** — it is exactly today's loop, lifted verbatim into
  a named record so nothing regresses while the mechanism generalizes.
- The **cross-project scope flag** is part of the schema from day one so the data model is honest,
  but **execution across projects is deferred** — `startRun` is still one-agent/one-worktree, so a
  cross-project run is a later increment, not part of the first cut (same posture as D-012's staged-
  engine growth point).

> **Sequencing (P5.3 split, D-043 → BUILT P5.3b, D-047).** The named-definition mechanism above
> has **landed** as **P5.3b**: a `workflow_definitions` table + `NamedWorkflow` repo/CRUD
> (`core/src/workflow-defs.ts`, `routes/workflows.ts`), with `buildDelegationPrompt` generalized —
> `renderWorkflowPrompt(scaffold, tasks)` renders a `{{CHECKLIST}}` token, and the exported
> `CODE_WAVE_SCAFFOLD` is the pre-P5.3b prompt **verbatim**, so `buildDelegationPrompt` is
> **byte-identical** and the existing workflow/dispatch tests stay green. The `code-wave` seed is that
> first named def; `investigate` + `refactor` are seeded alongside it. The **Workflows list + detail
> UI** (`WorkflowsPage` Definitions tab + `WorkflowDetailPage`) reads/edits them, and the **Settings
> org-default authority panel** surfaces the `default-orchestrator` grant leads inherit (§08).
> **P5.3a shipped first**: the Orchestrators roster + detail + per-lead authority control plane (§08).

> **Reused by the Chief→lead dispatch (loop-a, D-049).** `renderWorkflowPrompt` is now also the
> seed-builder for the autonomous **Chief→lead** hop: when the Chief `dispatch_lead`s an assignment,
> `core/src/chief-dispatch.ts::buildLeadSeed` renders the chosen NamedWorkflow's `promptScaffold`
> through the SAME `renderWorkflowPrompt` — passing the **objective as the single checklist item**
> (`[{ title: objective }]`) — then appends a lead charter line (open a PR, never push to a default
> branch). To serve both callers the signature was widened to `renderWorkflowPrompt(scaffold,
> readonly { title }[])` (a `ProjectTask` still satisfies it, so the todo-batch path is unchanged and
> byte-identical). The chosen workflow defaults to `code-wave` when the assignment named none. See §03
> *Chief→lead dispatch*.

## The delegation loop

The first workflow's loop is the harness's core methodology (see also §13 Observability, which
visualizes it):

```
orchestrator ──▶ implementer      (writes the change)
   ▲              │
   │              ▼
   │           spec-review         (does it meet the spec?)
   │              │
   │              ▼
   │           quality-review      (is it correct, simple, safe?)
   │              │
   └──────────────┘  orchestrator applies fixes → ONE reviewable commit / PR → CI gates the merge
```

Delegated agents run **in-process** via the `Task` tool (the CLI's subagent-spawn tool-id; "agent"
stays the prose concept — see §03), so a run's sub-agents *are* its `delegate` tool calls — there is
no separate sub-run table (reused; see §13). The worker roles are now real **subagent definitions**
(`agent-config/agents/*.md`) the orchestrator spawns, each tool-scoped to its authority. A review
role runs **every wave, no exceptions**; a separate whole-implementation review runs before merge. As
it goes, the orchestrator marks each ticket, loop phase, review, and the CI gate through the kstore
status-write tools so the run is visible as a live checklist (§13).

## Memory — layered, starting at A

Every durable profile (K, Chief, each lead) carries a **memory**. Memory is **layered**, and Phase 5
deliberately **starts at layer A** with storage shaped so B and C are a swap, not a rewrite — the
same posture the **ModelRouter** takes (start simple, grow into learned behavior on the same seam).
**Memory is a tool, not a file:** managed agents record lessons only through the kstore memory tool —
never by writing a file. (`tasks/lessons.md` is the human operator's home-development tracker, outside
the managed-run architecture.) K's **conversation** follows the same rule: the durable K thread
(`k_threads` / `k_thread_turns`, P5.1c) is a **tool-backed store, not a file**, so K's identity and
its own answers persist across reload while any run executing that thread stays ephemeral.

**Report-back lands on the same thread (D-046).** When K delegates an engineering ask up to the Chief
(`startAgentRun('chief', { trigger:'delegation' })` — see §03), the outcome comes back *where you
asked*: on the Chief run reaching terminal, `reportDelegationBack` (riding the run-lifecycle seam)
appends a `k` turn to the durable K thread, summarizing the Chief's latest **mgmt `report`** (or, as a
fallback, the run's assistant text / a status line). The up/down chain — you ask K, K hands up to the
Chief, the Chief works and reports up — is thus visible in the one place the operator is already
looking, over the existing thread + event stream (no new channel).

**The report continues past the Chief's turn (D-051, loop-b b2).** A Chief's bounded activation can
terminate BEFORE the lead it dispatched finishes — so `reportDelegationBack` (which fires on the
**Chief** terminal) can land a PRE-lead status. loop-b b2 closes that gap: `continueLeadOutcomeToK`
rides the **lead** run's terminal (the same main-EventBus signal the lead→Chief mgmt report uses) and,
IF the parent Chief run was itself a K delegation (resolved from the same `k_thread_turns.run_id` link
that recorded the hop), appends the lead's outcome one more hop UP onto the durable K thread ("Chief
(via <lead>) completed: …"). It is idempotent (the run-lifecycle once-latch) and a **no-op when the
Chief woke autonomously** (no linked thread). So the operator's thread reflects the lead's REAL
outcome, not just the Chief's mid-turn status — completing the up-chain the down-chain (§03) opened.

| Layer | What | Status |
|-------|------|--------|
| **A — tool-based lessons + gated reflection** | a managed agent calls kstore `lesson_propose` to propose ONE lesson; it lands **pending** in the `agent_memory` table and the **operator approves (or rejects)** it before it joins memory; `lesson_list` reads them back (run-scoped) | **BUILT (Phase 5)** — kstore tool + `agent_memory` table + operator gate surface (P5.1b) |
| **B — structured store + retrieval** | a structured lesson store with **relevance retrieval** and **outcome-weighting** (favor lessons that led to good outcomes), mirroring how ModelRouter weights run-outcome data | PLANNED — grow into |
| **C — verification/eval-derived lessons** | lessons derived automatically from **verification and eval** signals (a regression or a failed audit writes a lesson) | PLANNED — grow into |

**The gated reflection (layer A) is the key primitive.** A run ends → the profile proposes one
candidate lesson from what it learned → it is held **pending** → the operator approves (or rejects)
it → only then does it join the profile's durable memory. Nothing self-modifies its own brain
without a human gate. The store is keyed by profile id so each tier accumulates its own lessons,
and the approval gate + outcome metadata are exactly the hooks layer B's retrieval/weighting and
layer C's auto-derivation plug into later.

**The gate is now operator-usable (P5.1b).** The pending queue is no longer approvable only out of
band — a **Memory review** surface (sidebar → Memory) lists the proposed lessons as cards showing the
proposing profile and source run, with **Approve** / **Reject** actions, plus a lighter accepted/
rejected history view. It rides a thin HTTP gate (`GET /api/memory/lessons?status=&profileId=`,
`POST /api/memory/lessons/:id/approve|reject`) that performs **status transitions only**
(pending→accepted|rejected, validate-before-mutate: unknown id → 404, already-reviewed → 409) over
the **same `agent_memory` row** the kstore `lesson_propose` tool wrote — approving a lesson is the
producer's own row flipped in place, not a copy. Retrieval (surfacing accepted lessons back into a
run) is still layer B.

## Work items — one unified, scoped model

There is **one `work_items` table**, not a split between K-owned and project-owned tasks (decision
**D-026** unifies the earlier `agent_tasks` / `project_tasks` model). A single **`scope`**
discriminator says where an item lives:

| `scope` | What | Owner |
|---------|------|-------|
| **`personal`** | K's own global checklists — org-level reminders, cross-cutting to-dos (K-owned) | K |
| **`org`** | a Chief **objective** — an org-level engineering goal the Chief is staffing | Chief |
| **`project`** | a project-scoped ticket that lives in a project workspace and feeds delegation workflows (§05) | the project |

**K may create `personal` OR `project` items** — a loose end for the org, or a ticket scoped to a
specific project — so "**K can add to project tasks**" is preserved without a second table. Items are
**promotable** along the same row: a `personal` note can be promoted to an `org` objective, and an
`org` objective scoped down to a `project` ticket, as work firms up. One table keeps a project's task
list a clean unit of engineering work while still giving K and the Chief somewhere to track looser
items — and lets every task surface (K-home work-items, Chief objectives, a project's Tasks tab) read
from one store.

```ts
WorkItem {                     // PLANNED — Phase 5 (unified; replaces the agent_tasks/project_tasks split)
  id: uuid
  scope: 'personal' | 'org' | 'project'   // personal = K-owned · org = a Chief objective · project = project-scoped
  text: string
  status: 'open' | 'in_progress' | 'done'
  projectId?: uuid             // set iff scope === 'project' (the §05 project it belongs to)
  createdAt: number
}
```

> **What ships today (unified storage; `scope` P5.1d1, storage collapse P5.1d2a).** The built
> `work_items` table + kstore tools (`work_item_create` / `work_item_list` / `work_item_update`) are the
> storage-as-tools replacement for the home-dev `tasks/todo.md`; run-scoped (`scope='personal'`)
> tickets are owned by the managed run that created them (a run reads/mutates only its own). The
> **`scope` discriminator landed** as the D-026 down-payment (P5.1d1, **D-045**), defaulting to
> **`personal`**. The **storage collapse then landed** (P5.1d2a, **D-048**): `work_items` gained
> `project_id` + the issue-sync columns (`completed_at` / `issue_number` / `issue_url` / `issue_state`),
> a guarded, idempotent `migrate()` **backfills** every `project_tasks` row into `work_items`
> (`scope='project'`, `project_id` set, issue-linkage preserved), and the `projectTasksDb` helpers are
> **re-pointed onto the one `work_items` store** — so the project Tasks route, GitHub issue-sync, and
> the delegation-dispatch path already read/write the unified table **behind their unchanged public
> APIs** (the P5.1d characterization tests stay green through the collapse). The old `project_tasks`
> table is **deprecated + frozen** (its rows copied, not deleted; nothing writes to it) pending a drop.
> What remains **deferred to P5.1d2b** is the surface reroute — having `routes/projects.ts` /
> `github.ts::syncIssues` / `workflows.ts` call the work-item store *directly* (retiring the
> compatibility helpers), collapsing the two Tasks UI surfaces into one **scope-aware** view, wiring
> row **promotion** (`personal → org → project` via `work_item_update`), and dropping `project_tasks`.
>
> ```ts
> WorkItem {                   // BUILT — kstore working store (scope column landed P5.1d1)
>   id: uuid
>   runId: string | null       // the managed run that created it (resolved from injected K_RUN_ID)
>   title: string
>   body: string | null
>   status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
>   scope: 'personal' | 'org' | 'project'   // D-026 discriminator; 'personal' today (run-scoped)
>   createdAt: number; updatedAt: number
> }
> ```

### K's logistics store — a sibling, not a second task table

K's **logistics** working store (P5.1a, bible §03) ships alongside kstore as its OWN run-scoped
MCP server over three tables — `logistics_notes`, `logistics_events`, `logistics_reminders` —
exposing `note_* / event_* / reminder_*`. It is deliberately **not** a task store: K's *tasks* stay
the kstore `work_item_*` tools (and unify with `project_tasks` under D-026 later), while logistics
holds only the non-ticket logistics data K shows on K-home (notes, calendar events, reminders).
Same run-scoping and null-owner degrade as kstore; **storage, not execution** — an event stored
here is never scheduled on a real calendar (the Google connectors remain the Phase-5 path for that).
