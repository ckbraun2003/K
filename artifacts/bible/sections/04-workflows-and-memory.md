---
title: Workflows & Memory
icon: "⟲"
status: active
updated: 2026-06-28
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
WorkflowDefinition {            // PLANNED — Phase 5 (generalizes today's single buildDelegationPrompt)
  id: uuid
  name: string                 // "implement+review" (the first), "investigate", "refactor", …
  roles: Role[]                // the role-subagent sequence (e.g. implementer → spec-review → quality-review)
  promptScaffold: string       // how the goal + roles are rendered into the controller prompt
  crossProject: boolean        // may the run touch more than one project? (flag lands; multi-project EXECUTION deferred)
}
```

- **`implement+review` is the first definition** — it is exactly today's loop, lifted verbatim into
  a named record so nothing regresses while the mechanism generalizes.
- The **cross-project scope flag** is part of the schema from day one so the data model is honest,
  but **execution across projects is deferred** — `startRun` is still one-agent/one-worktree, so a
  cross-project run is a later increment, not part of the first cut (same posture as D-012's staged-
  engine growth point).

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
the managed-run architecture.)

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

> **What ships today (run-scoped, kstore).** The built `work_items` table + kstore tools
> (`work_item_create` / `work_item_list` / `work_item_update`) are the storage-as-tools replacement
> for the home-dev `tasks/todo.md` — tickets are **run-scoped** (owned by the managed run that
> created them; a run reads/mutates only its own) rather than carrying the `scope` discriminator
> above. Unifying this run-scoped store with `project_tasks` under the `personal | org | project`
> model (D-026) is the deferred next increment; the operator's project Tasks tab still reads
> `project_tasks` (§05).
>
> ```ts
> WorkItem {                   // BUILT — kstore working store
>   id: uuid
>   runId: string | null       // the managed run that created it (resolved from injected K_RUN_ID)
>   title: string
>   body: string | null
>   status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
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
