---
title: Workflows & Memory
icon: "⟲"
status: active
updated: 2026-06-27
---

> **Status — mostly PLANNED (Phase 5).** Today the harness has **one** hardcoded delegation loop
> (`core/src/workflows.ts`) and **file-based** lessons (`tasks/lessons.md`). This section describes
> how both generalize: named **workflow definitions** an orchestrator runs, and a **layered memory**
> that starts at file-based lessons (layer A) and grows into a retrieval store (B/C). What exists
> today is marked **reused**; the rest is the Phase-5 design (decisions D-022, and the workflow
> generalization noted in D-012's growth path).

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
controller ──▶ implementer        (writes the change)
   ▲             │
   │             ▼
   │          spec-review          (does it meet the spec?)
   │             │
   │             ▼
   │          quality-review       (is it correct, simple, safe?)
   │             │
   └─────────────┘  controller applies fixes → ONE reviewable commit / PR → CI gates the merge
```

Delegated agents run **in-process** via the Agent/Task tool, so a run's sub-agents *are* its
`delegate` tool calls — there is no separate sub-run table (reused; see §13). A review role runs
**every wave, no exceptions**; a separate whole-implementation review runs before merge.

## Memory — layered, starting at A

Every durable profile (K, Chief, each lead) carries a **memory** that composes with the project's
`tasks/lessons.md`. Memory is **layered**, and Phase 5 deliberately **starts at layer A** with
storage shaped so B and C are a swap, not a rewrite — the same posture the **ModelRouter** takes
(start simple, grow into learned behavior on the same seam).

| Layer | What | Status |
|-------|------|--------|
| **A — file-based lessons + gated reflection** | per-agent markdown lessons; a **gated end-of-run reflection** proposes a *pending* lesson which the **operator approves** before it enters memory; composes with the project's `lessons.md` | **start here (Phase 5)**; file lessons exist today (reused) |
| **B — structured store + retrieval** | a structured lesson store with **relevance retrieval** and **outcome-weighting** (favor lessons that led to good outcomes), mirroring how ModelRouter weights run-outcome data | PLANNED — grow into |
| **C — verification/eval-derived lessons** | lessons derived automatically from **verification and eval** signals (a regression or a failed audit writes a lesson) | PLANNED — grow into |

**The gated reflection (layer A) is the key primitive.** A run ends → the profile proposes one
candidate lesson from what it learned → it is held **pending** → the operator approves (or rejects)
it → only then does it join the profile's durable memory. Nothing self-modifies its own brain
without a human gate. The store is keyed by profile id so each tier accumulates its own lessons,
and the approval gate + outcome metadata are exactly the hooks layer B's retrieval/weighting and
layer C's auto-derivation plug into later.

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
