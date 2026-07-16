---
title: Workflows & Memory
icon: "⟲"
status: active
updated: 2026-07-13
---

> **Status — BUILT (Phase 5, finalized P5.7).** The single hardcoded delegation loop
> (`core/src/workflows.ts`) generalized into **named workflow definitions** (P5.3b, D-047), with the
> orchestrator **reporting progress** through the kstore status-write tools. **Memory layer A is
> built as a TOOL, not a file**: managed agents propose lessons through kstore `lesson_propose`
> (gated, held pending) into the `agent_memory` table — now **profile-linked** (D-053) —
> `tasks/lessons.md` is a **home-development-only** tracker, never written by a managed run. Work
> items are the **unified, `scope`-discriminated `work_items` store, fully collapsed**
> (D-045 → D-048 → D-053 → D-058: `project_tasks` is dropped). **Still planned:** memory layers B/C
> (retrieval/weighting) and scope **promotion** along a row.

A lead does work by **running a workflow** and gets smarter over time through **memory**. Both are
configuration, not new engines — the substrate is the supervisor/EventBus already in place.

## Workflow definitions

Today, `workflows.ts` carries a single, hardcoded loop: `buildDelegationPrompt(tasks)` renders a
selection of todos as a checklist and instructs one supervised controller run to act out the
delegation loop in its own worktree, producing one reviewable PR (decision D-012). That loop is
**prose methodology** the orchestrator carries out internally — it is not a multi-run engine.

> **SUPERSEDED — the executable pipeline engine landed (D-119, 2026-07-16).** The "not a multi-run
> engine" limitation is now closed. `workflow_definitions.spec` carries an executable `PipelineSpec`
> (Zod in `@k/shared`) that a main-process `PipelineEngine` + scheduler walks as a real DAG:
> `agent`/`deterministic`/`gate`/`hook` stages, per-edge `share-tree`/`branch`/`merge` handoff via the
> checkpoint chain (sweep-immune `refs/k-pipelines/…`), declarative + dynamically-inserted gates,
> retry-in-place (the self-heal retry brain + the `runs.pipeline_stage_id` ownership guard that prevents
> double-fire), conditional forward routing (`markSkips` + skip-aware finalize), and reboot reconcile —
> all built the lead-relay way (DB ledger + CAS claim). K (or the operator) delegates via
> `delegate_pipeline` / `POST /api/pipelines/:id/run`, and the Agents→Pipelines tab renders the live DAG.
> The legacy `NamedWorkflow`/`buildDelegationPrompt` path stays for backward-compat — a legacy row lazily
> compiles via `namedWorkflowToPipeline`. Seeded reference pipelines: `code-wave` (implementer → parallel
> share-tree reviews → merge-join controller → gate → verify), `investigate`, `refactor`. See §10 D-119
> and the §09 roadmap. **Deferred:** repair-LOOP back-edges, `commit`/`ci` deterministic actions, hook
> `inject` propagation, run-internal operator hooks (Phase 1.5), the injection intelligence (Phase 3).

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

> **Operator launcher — "Run this workflow" (P5.7 C2).** A named definition is now directly
> launchable from its own detail page: `WorkflowDetailPage`'s **Run this workflow** dialog picks a
> project → its open tasks → dispatches, and the existing task-dispatch route
> (`POST /api/projects/:id/tasks/dispatch`) accepts an optional **`workflowId`** that seeds the
> prompt from THAT definition's `promptScaffold` through the same `renderWorkflowPrompt` seam
> (unknown id → a clean `400`, validate-before-mutate: no `workflow_run` row inserted, no task
> locked; omitted → the `code-wave` default, byte-identical to before). A new
> `GET /api/workflows/runs` feeds the Run-tree picker's **workflow-only default filter** (with an
> all-runs toggle; deep links default to all).

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

## Skills — capability catalog vs automation registry (BUILT — host-integration program)

The skills a run can mount and the skills the operator automates are **one store with two
surfaces** (D-069/D-071):

- **The capability catalog** (`GET /api/capabilities/skills`, the Skills-page Catalog tab — §08)
  is every *mountable* skill with provenance: K-native rows **plus discovered host assets** (user /
  project / plugin skills), keyed by **one canonical qualified-key grammar** (the wire `id` *is*
  the key): bare `<name>` (k-native — zero migration for existing rows and profiles),
  `user:<name>`, `project:<projectId>:<name>`, `plugin:<plugin>@<marketplace>:<name>`. A
  discovered row is a **metadata snapshot** (source kind, origin path, content hash, est-tokens,
  `status ok|missing`) — default-disabled behind the K-scoped overlay; its content stays on host
  disk and is vendor-copied into the run config at synth time (§02).
- **The automation registry** (the Automations tab) is the pre-existing K skills surface —
  triggers, schedules, eval history — unchanged: `GET /api/skills` stays **byte-compatible**,
  returning k-native rows only.

**Est-token conventions.** Every figure comes from one heuristic seam
(`core/src/token-estimate.ts`: `ceil(chars/4)`, documented ±25%, deliberately no tokenizer
dependency — a one-module swap seam) and is labeled an *estimate*, never a billed figure:
`est_tokens` = the full SKILL.md (the on-invocation cost); `est_tokens_meta` = the raw frontmatter
block (the always-loaded index cost; name+description fallback when no block parses); an MCP
server's `est_tokens` = its probed tool-schema JSON — **null until probed**.

**The Skill Creator (D-071)** grows K's own library through a drafts lifecycle (`skill_drafts`
table; UI at the hidden `#/skill-creator` route — §08): **brief → authoring run** (dispatched
under the fail-closed `k-secretary` profile — a missing profile fails the draft rather than
silently escalating; the authoring-guidance skill `agent-config/skills/skill-authoring` is
embedded in the prompt) **→ ready | failed → manual edit / refine revisions** (a refine on a
failed *first* draft is a fresh retry at revision 0) **→ evaluate** (the same eval harness skills
use, over a parallel `skill_draft_evals` table, cascade-deleted with its draft) **→ save**. Save
lands **exclusively in K's library** — `agent-config/skills/<slug>/SKILL.md` (slug guarded incl.
Windows reserved device names; 409 on collision; crash-honest rollback) — and registers the
catalog row with provenance `'k'`. A draft is never presented as a saved skill until `/save`
lands it.

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
| **C — verification/eval-derived lessons** | lessons derived automatically from **verification and eval** signals (a regression or a failed audit writes a lesson) | **PARTIAL (P5 Autonomy, E-27, D-113)** — a deterministic collector turns repeated (≥2) same-signature failures into ONE deduped, capped (10) **pending** `agent_memory` lesson **through the layer-A gate above** (the `lesson_pending` inbox, no new UI); scoped to **`verify_results` only** (`eval_results` deferred — no failure-reason column). Retrieval/weighting stays layer B |

**The gated reflection (layer A) is the key primitive.** A run ends → the profile proposes one
candidate lesson from what it learned → it is held **pending** → the operator approves (or rejects)
it → only then does it join the profile's durable memory. Nothing self-modifies its own brain
without a human gate. The store is keyed by profile id so each tier accumulates its own lessons,
and the approval gate + outcome metadata are exactly the hooks layer B's retrieval/weighting and
layer C's auto-derivation plug into later.

**The profile key is now REAL (P5.7, D-053).** `agent_memory.profile_id` — added at P5.0 but left
NULL by the producer — is now **populated**: `lesson_propose` resolves the calling run's profile via
its `agent_runs` activation and binds it on insert, and a one-shot best-effort backfill
(`mig_agent_memory_profile_backfill`) resolved pre-existing lessons the same way (a lesson whose run
has no activation row stays NULL). So per-profile lesson retrieval — the layer-B hook, and the
Memory-review page's per-profile filter (P5.7 C2, over the route's pre-existing `profileId` param)
— reads a real column, not a hope.

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
**D-026** unifies the earlier `agent_tasks` / `project_tasks` model; **D-053** finalized the scope
enum; **D-058** dropped `project_tasks` itself). A single **`scope`** discriminator says where an
item lives and how long it lives:

| `scope` | What | Lifetime |
|---------|------|----------|
| **`run`** | a managed run's own working tickets (the kstore **default** — a lead's checklist for one wave) | **ephemeral** — visible only to the run that created it |
| **`personal`** | the operator's own list — reminders, cross-cutting to-dos K keeps for you | **durable operator-global** (persists across sessions and runs) |
| **`org`** | an org-wide item — an org-level goal being tracked | **durable operator-global** |
| **`project`** | a project-scoped ticket that lives in a project workspace and feeds delegation workflows (§05) | owned by the project |

**Who creates what (as-built, D-053).** K creates **`personal`** (or `org`) items — durable, so
"K's list survives the run that wrote it"; a managed run's working tickets default to **`run`**
(the original run-isolated semantics, unchanged for leads); and **`project`** tickets are created
via the **projects API only** — kstore **REJECTS `scope='project'`** at the tool boundary with an
explicit error. Durable scopes filter by **scope only** (`run_id` is kept on insert as provenance,
never as an access filter); `run` scope keeps the ownership guard. Scope **promotion** along the
same row (`personal → org → project` via `work_item_update`) is **not wired** — the update tool
edits status/title/body only; promotion remains a later increment. One table still buys the D-026
point: every task surface (K-home work items, a project's Tasks tab) reads from one store.

```ts
WorkItem {                     // BUILT — @k/shared (unified store; scope enum final per D-053)
  id: uuid
  runId: string | null         // provenance: the run that created it (access filter for 'run' scope only)
  title: string
  body: string | null
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
  scope: 'run' | 'personal' | 'org' | 'project'
  projectId?: uuid             // set iff scope === 'project' (the §05 project it belongs to)
  // + completed_at / issue_number / issue_url / issue_state (the GitHub issue-sync metadata)
  createdAt: number; updatedAt: number
}
```

The durable scopes also have an operator HTTP surface — **`GET/POST/PATCH /api/k/work-items`**
(bearer-authed, `personal`+`org` only; `run` and `project` rows are unreachable there by design) —
which is what K-home's *Your work* card reads and writes (§08).

### Proposals → backlog → auto-pull (BUILT — P5 Autonomy, E-14/E-15)

The autonomous org's work queue is **the same `org`-scoped `work_items` store, not a new table**. A
**proposal** is an `org` item created `status='blocked'` with a `source` + `source_key` (the two P5
columns): deterministic zero-token collectors write them from CI/verify/issue/bible signals (§07), and
a self-heal park writes one from a failed run (§07). Its lifecycle rides the ordinary status enum:

- **`blocked`** = an unapproved proposal — surfaced in **Personal → Inbox** as a proposal card (§08),
  **deduped by a partial-unique `source_key` index**, open-capped (20).
- **approve → `open`** — the item **enters the backlog** (the backlog *is* the set of `open` org
  items, ordered `created_at ASC`); **dismiss → `cancelled`** (STICKY — the `source_key` still resolves
  the cancelled row, so the collector never re-nags; no undo on dismiss — D-111).
- **auto-pull → `in_progress`** — **E-15**, an interval relay (`core/src/backlog-relay.ts`, gated
  `enabled && backlogAutoPull`) **CAS-claims** the oldest `open` org item (`open→in_progress`, mirroring
  the lead-dispatch relay's atomic claim so overlapping drains can't double-pull), governed by the
  **budget gate** (§13) + the autonomy **max-concurrency** cap, then dispatches it under the
  **default orchestrator**. The dispatched run id is stamped back onto the claimed item.

So the loop is: a signal → a **blocked** proposal → the operator **approves** it into the **open**
backlog → the relay **claims + dispatches** it — every step a status transition on one row, no new
table, all inert while autonomy is OFF (§03).

> **How it got here (the collapse, completed).** The `scope` discriminator landed as the D-026
> down-payment (P5.1d1, **D-045**); the **storage collapse** followed (P5.1d2a, **D-048**):
> `work_items` gained `project_id` + the issue-sync columns and a guarded backfill copied every
> `project_tasks` row in (`scope='project'`), with the helpers re-pointed behind unchanged public
> APIs. **P5.7 A2 (D-058) then COMPLETED d2b**: a final one-shot backfill ran and **`project_tasks`
> was DROPPED** — fixing the boot-resurrection bug where a task deleted via the API re-appeared
> from the frozen copy on every boot. The helper layer was renamed **`projectTasksDb` →
> `projectWorkItemsDb`** and is now the *first-class* project-scoped surface of the one store (not
> a compat shim): `routes/projects.ts` and `github.ts::syncIssues` ride first-class `work_items`
> statements with **zero HTTP shape change**. A **partial UNIQUE `(project_id, issue_number)`
> index** (after a dedupe) makes GitHub issue-mirroring idempotent by construction, and
> `updateProjectTaskFromIssue` binds `project_id` in its WHERE as a cross-project defense. Finally,
> **P5.7 A1 (D-053)** finalized the scope enum — the NEW **`'run'`** value took over the old
> run-isolated semantics as the kstore default, and a **one-shot flag-guarded table rebuild**
> re-stamped legacy `personal` AND `org` rows to `'run'` (both had behaved run-scoped pre-A1, so an
> untouched legacy `org` row would have silently escalated into the durable operator view).

### K's logistics store — a sibling, not a second task table

K's **logistics** working store (P5.1a, bible §03) ships alongside kstore as its OWN MCP server
over three tables — `logistics_notes`, `logistics_events`, `logistics_reminders` — exposing
`note_* / event_* / reminder_*`. It is deliberately **not** a task store: K's *tasks* stay the
kstore `work_item_*` tools (unified under D-026/D-053), while logistics holds only the non-ticket
logistics data K shows on K-home (notes, calendar events, reminders). Since P5.7 (D-053) the store
is **operator-durable, not run-scoped** — reads/updates drop the run filter (K's notes and schedule
survive across sessions; `run_id` stays as insert provenance), which is what feeds K-home's Notes +
Schedule cards (`GET /api/k/notes` / `GET /api/k/schedule`, §08). Still **storage, not execution** —
an event stored here is never scheduled on a real calendar (the Google connectors remain **unwired**;
see §03 *Reused connectors*).
