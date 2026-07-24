---
title: Workflows & Memory
icon: "🔀"
status: active
updated: 2026-07-24
---

K's agent organization (§03) does its work in two modes and remembers what it learns through a
third system. This section documents the **workflow doctrine** — the two work modes a chief
operates in, the pipeline system that is the organization's SOP, the loops that keep work from
stopping early or drifting forever, the ledgers that make it auditable, and the correspondence
model that keeps an event-driven organization visible — followed by **memory**, which is how a
profile gets smarter across runs instead of starting cold every time. Positions, doctrine, gates,
and autonomy levels used throughout are defined in §03 and are not redefined here.

## Two work modes

A chief does everything it does in one of two modes. Same chief, same doctrine, same typed
handback contract (§03) — only the wake context and the gate handling differ.

| | **Active — a commission** | **Passive — a standing job** |
|---|---|---|
| Origin | The user, via K — or directly, in the chief's thread | The system — a shipped catalog, armed and scheduled by the user |
| Authored by | The user's request | The system — never the user, never an agent |
| Wakes into | The chief's standing thread | Clean context |
| Someone waiting | Yes | No |
| Autonomy means | Who holds the gate key | Whether it is armed, and how far its pre-authorized scope reaches |
| Decided | During the work | Before it starts |
| Terminates in | A final report in the thread | Reports on the standing-work board |

### Active — a commission

K writes a commission into the chief's thread — an objective, its constraints, its known
acceptance criteria. The chief wakes into that thread, exercises discretion, chooses its means, and
proceeds. Checkpoint reports post to the thread as the work progresses; gates surface to the user or
are resolved by the chief if it is authorized to (§03), and either way they are recorded and posted.
The chief closes with a final report in the same thread.

### Passive — a standing job

A trigger fires, the chief wakes with clean context, does the job, files its reports, and sleeps.
**Passive autonomy is fixed before the job ever runs** — whether it is armed, and how far its
pre-authorized scope reaches — never negotiated while it works, which is the opposite of active
autonomy's "who holds the gate key, decided during the work."

Clean-context wake carries two consequences. A standing job is **self-contained**: its brief comes
from the catalog definition plus current system state, never from conversation history — which is
what makes it repeatable and schedulable on a cadence nobody has to babysit. And **a passive job
never blocks**: it completes everything within its pre-authorized scope and converts anything
beyond that scope into a proposal rather than stopping to ask. A standing job that parked waiting on
an answer would be hung, not paused, so it never does.

Standing jobs are drawn from a **shipped catalog — never authored by the user and never authored by
an agent.** Arming one only ever toggles cadence and pre-authorized scope; it never invents new
procedure.

### The seam between modes

**Approving a proposal commissions it.** A standing job's output is, in effect, "here is what I
did, here is what needs you" — and the things that need the user become active commissions the
instant they are approved. The decision queue (see *Boards*, below) is where passive work re-enters active work;
nothing about a proposal's origin as passive output survives approval — once accepted, it is a
commission like any other.

### Reporting asymmetry

A routine standing job always writes to the standing-work board — that record exists whether or not
anyone reads it. It posts into the chief's thread only when there is something *for the user*: a
proposal, an escalation, a notable finding. A colleague does not message you every time it finishes
a routine task; the record still exists for whoever wants to check.

## Pipelines — the SOP system

Pipelines are the organization's standard operating procedure for doing work. They are deliberately
**few and deeply designed, not a catalog** — a pipeline is a designed system with typed inputs, a
defined artifact per phase, explicit decision points, and a defined output, not a script of
prompts. **Skills are abundant and granular; pipelines are broad and precise.** Consistency comes
from there being few of them, and from every one sharing the same anatomy.

### One anatomy

Every work pipeline is the same shape, instantiated differently:

```
Ground ──► [ Scale ──► Cohort ──► Converge ──► Orchestrator gate ]* ──► Review swarm ──► Terminal gate
```

- **Ground** — read the project bible and relevant documentation, and produce a grounding
  artifact. Every pipeline starts here; the bible is the one consistent source of project truth
  every agent reads, so no unit ever begins from a blank slate or from whatever the last
  conversation happened to say. Ground depends on the bible existing — **a pipeline cannot run
  against a project with no bible** — which is exactly what the project-onboarding system pipeline
  (below) manufactures.
- **Scale** — the orchestrator chooses cohort width, from **1 to 5**, and **must justify that
  choice in the ledger** (see *Ledgers and artifacts*, below). The choice is bounded by the unit's
  remaining allowance, so a scale decision draws down the same budget tree as everything else (see
  *Loops*).
- **Cohort** — N agents work one objective, in one of two modes: **convergent**, where each
  produces a candidate and a synthesis pass follows — right for planning, where diverse approaches
  beat one approach iterated — or **partitioned**, where the work splits into disjoint sub-parts
  that are later merged — right for implementation.
- **Converge** — the cohort's output becomes a named, addressable pipeline artifact. A plan is an
  artifact; an implementation is an artifact.
- **Orchestrator gate** — an **orchestrator gate** (§03): the orchestrator approves, or denies and
  re-runs the phase with adjustments, bounded by the loop's own budget (see *Loops*). It lives in
  the unit ledger and never reaches the user.
- **Review swarm** — parallel quality and spec review, one to N reviewers, producing a review
  artifact.
- **Terminal gate** — the pipeline's **escalated gate** (§03). For Code, this is the merge gate;
  for Operate, a floor-class gate; Investigate has none.

**Every phase closes by producing a readable artifact** — that is what makes the whole pipeline
inspectable at any depth. The orchestrator **reads the review artifact before resolving the
terminal gate**: that artifact is both the visibility surface for the user and the loop context
that lets a denied review re-run intelligently instead of blindly.

### The four broad work pipelines

The everyday SOP. Any qualified orchestrator runs these four; intent and discipline are parameters,
not separate pipelines — **a bugfix is `Code`, not its own pipeline.**

| Pipeline | Covers | Instantiation | Terminal |
|---|---|---|---|
| **Code** | Any change to a codebase — feature, bugfix, refactor, upgrade | Ground → plan cohort (convergent) → plan artifact → orchestrator gate → impl cohort (partitioned) → impl artifact → orchestrator gate → review swarm → review artifact → merge gate | Merge gate (escalated) |
| **Investigate** | Read-only — feasibility, root cause, architecture, audit | Ground → one cohort → report artifact | None |
| **Verify** | Independent verification of existing work | Ground → discipline cohort → findings artifact + proposals | Findings; proposals enter the decision queue |
| **Operate** | Acting on running systems — deploy, release, rollback, incident | Ground → plan → orchestrator gate → execute → operation artifact | Floor-class gate (escalated) |

### Specialized pipelines

A distinct class: unique, deeply designed systems for **specialized, uncommon work**, not everyday
development. Each is discipline-bound and its own designed system — **not a parameter set** of the
broad four. This is what "orchestrator-specific" means: not a special category of orchestrator,
just a pipeline whose discipline requirement happens to be set.

| Pipeline | Discipline | For |
|---|---|---|
| `live-smoke` | frontend | Driving the running application end to end against real surfaces |
| `mass-pen-test` | security | Broad adversarial security sweep |
| `regression-sweep` | test | Wide re-verification across a suite |

These are added as genuine new pipelines over time, not spun up per request.

### System pipelines

The system operating on itself, triggered by **system events** rather than commissioned — passive
work with an event trigger instead of a cadence. Both are owned by Operations, since repo lifecycle
already is, and each produces a first-class artifact:

| Pipeline | Trigger | Produces |
|---|---|---|
| **Project onboarding** | A project is registered | Analyzes the codebase and writes a properly structured project bible and artifacts directory — the source of truth every subsequent Ground phase reads |
| **Documentation sync** | Drift detected between code and bible | Re-analyzes and updates the bible; emits a sync-report artifact |

Onboarding is load-bearing: it manufactures the bible that makes Ground possible for everything
else.

## Loops

Three scales, three meanings of "keep going." What makes them one system is a shared invariant:
**every loop has an exit condition, a budget, and someone above it who hears about failure.**

| | **Pipeline iterate** | **Orchestrator satisfaction** | **Chief objective** |
|---|---|---|---|
| Owner | The pipeline definition | The orchestrator, for its unit | The chief, for a commission |
| Goal | A condition on stage output | The acceptance criteria recorded before dispatch | The objective as commissioned |
| Judgment | None — mechanical | "Is this actually good?" | "Is this actually done?" |
| Between attempts may | Retry the stage | Change approach, re-plan, use a different worker | Re-commission — a different unit, orchestrator, or discipline |
| Bounded by | A declared iteration cap | Retries, spend, time | Commission budget, escalation triggers |
| On exhaustion | Stage fails | Escalate to chief | Escalate to user |

### Nobody may move their own goalposts

An orchestrator's acceptance criteria are fixed when the unit starts; loosening them is an
escalation, never a decision it can make on its own. A chief's objective is fixed when the
commission is accepted; changing it is a renegotiation with the user — a message, not an internal
call. Without this rule, "keep working until it is good" degenerates reliably into "redefine good,"
and every loop terminates in a confident false report.

### The failure ladder

> stage fails → pipeline retries it (cap) → orchestrator changes approach (budget) → chief
> re-commissions differently (budget) → the user hears about it

Each rung has strictly more expensive options than the one below it, which is the correct order in
which to spend. Because every iteration emits a checkpoint, a grinding loop is visible *while* it
grinds — intervention is possible at rung two rather than discovery at rung four.

### Nested budgets

The ladder's danger is multiplicative: three iterations by three retries by three re-commissions is
twenty-seven units of work from one request. Budgets are therefore **nested and enforced
downward**. The commission carries an allowance; the chief allocates from it per unit; the
orchestrator allocates from that per retry; the pipeline's iteration cap sits inside that. A child
can never exceed its parent's remaining allowance, and the parent sees the drawdown. Standing jobs
receive their allowance at arming time.

## Ledgers and artifacts

Ledgers and artifacts are mandatory at every level, not just for the broad work pipelines:

- **Orchestrator ledger, per unit** — created at unit start, appended at every checkpoint:
  acceptance criteria, scale decisions and their justification, cohort composition, artifacts
  produced, gate outcomes, retries, spend.
- **Chief ledger, per goal** — objective, means chosen, units dispatched, gates resolved (by whom,
  why), escalations, drawdown, status. A chief's goal-level artifacts — the objective/decision
  record, the final report — hang off this ledger.
- **System pipelines** carry ledgers and artifacts on the same terms; onboarding and documentation
  sync are not exempt.

**The ledger is the write side; threads and boards are read-side projections; the report is the
ledger's closing entry.** A checkpoint is not a separate act of reporting — it is a ledger append
that surfaces (see *Oversight granularity equals reporting granularity*, below). And a report is
only as good as what it points to: **a report whose claimed evidence artifacts do not exist does
not validate.** "Tests passed" without a linked run is a rejected submission, not a completed one.

## Correspondence and visibility

Because a chief is event-driven (§03) and nobody is resident watching a run happen, the
organization has to make its own state visible without anyone staying awake to narrate it. That is
what threads and boards are for.

### Threads

Per the correspondence model, a thread is a room, not a DM: one thread per chief, with three
participants — the user, K, and that chief. A commission K writes *is* a message in that room,
visible and replyable, never a hidden side channel; the user may also talk to a chief directly
without going through K. The sidebar is people: K, and one entry per chief, nothing else.

Messages are typed: `message · commission · checkpoint · gate · escalation · report`. That typing
is what lets one write feed several surfaces at once (see *Oversight granularity*, below).

**The thread is the record; the working context is a window onto it.** A standing thread never
ends, so a chief wakes with a rolling summary plus recent messages plus current state — not full
history. Durable truth lives in the thread, not in anyone's context window.

### Boards

Three projections over the same event stream:

- **Decision queue** — what needs the user: gates, proposals, escalations, each with the evidence
  needed to decide and what is blocked behind it.
- **Standing work** — every armed job across every domain: cadence, last fired, what it did, next
  fire, allowance drawdown.
- **Activity** — what is happening right now: which chiefs are awake, which units are live, which
  loop is on which iteration, spend against budget.

**The activity board is the direct mitigation for event-driven chiefs**: nobody is resident, so the
system itself holds the live picture instead.

### Oversight granularity equals reporting granularity

Because nobody is watching, reports cannot be terminal-only. Position procedure (§03) mandates
interim posts at defined checkpoints — stage transitions, gate resolutions, threshold crossings,
discipline handoffs.

**One checkpoint write is simultaneously a chief-wake event, a thread message, a board row, and an
audit entry** — four consumers, one source (the ledger, above). Mandatory reporting is therefore
not overhead bolted onto the real work; it *is* the coordination substrate.

The visual surface for threads and boards lives in §08 Dashboard UX and §13 Observability.

## Standing jobs — default arming

Standing jobs split by blast radius. Armed jobs are advisory only — they cannot change anything;
disarmed jobs write.

**Armed by default — advisory only, cannot change anything:**

| Domain | Job | Cadence |
|---|---|---|
| Quality & Security | Review open changes | hourly |
| Quality & Security | Dependency vulnerability audit | daily |
| Quality & Security | Test health and flake triage | daily |
| Operations | CI failure triage — investigates and proposes, never pushes | on red build |
| Engineering | Backlog grooming — reads, clarifies, proposes ordering | daily |

**Disarmed by default — these write:**

| Domain | Job | Cadence |
|---|---|---|
| Engineering | Backlog execution | daily |
| Operations | Dependency upgrade sweep | weekly |
| Operations | Repo hygiene | weekly |

A fresh install does nothing, and by morning has produced a review of open changes, a triage of
failing tests, a vulnerability report, and a groomed backlog — with zero blast radius, because none
of those jobs can change anything. The jobs that act are one deliberate toggle away.

**All chiefs start at L0 Attended** (§03); the floor is intact in every domain regardless of which
standing jobs are armed.

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

Every durable profile (K, Chief, each orchestrator) carries a **memory**. Memory is **layered**,
and Phase 5 deliberately **starts at layer A** with storage shaped so B and C are a swap, not a
rewrite — the same posture the **ModelRouter** takes (start simple, grow into learned behavior on
the same seam). **Memory is a tool, not a file:** managed agents record lessons only through the
kstore memory tool — never by writing a file. (`tasks/lessons.md` is the human operator's
home-development tracker, outside the managed-run architecture.) K's **conversation** follows the
same rule: the durable K thread (`k_threads` / `k_thread_turns`, P5.1c) is a **tool-backed store,
not a file**, so K's identity and its own answers persist across reload while any run executing
that thread stays ephemeral.

**Report-backs land on the thread they came from.** A commission's outcome — a chief's final
report, an escalation, a checkpoint digest — is delivered as a typed message into the thread the
commission was written to (see *Correspondence and visibility*, above), so the operator finds the
answer where they asked the question, not in a separate channel. This delivery mechanism predates
the current doctrine — it shipped as the mailbox/conversation subsystem (D-046, D-051, D-124) — and
continues to serve as the transport underneath threads; only the position vocabulary above it
changed, from a single Chief dispatching a lead to a per-domain chief driving orchestrators (§03).

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
| **`run`** | a managed run's own working tickets (the kstore **default** — an orchestrator's checklist for one wave) | **ephemeral** — visible only to the run that created it |
| **`personal`** | the operator's own list — reminders, cross-cutting to-dos K keeps for you | **durable operator-global** (persists across sessions and runs) |
| **`org`** | an org-wide item — an org-level goal being tracked | **durable operator-global** |
| **`project`** | a project-scoped ticket that lives in a project workspace and feeds delegation workflows (§05) | owned by the project |

**Who creates what (as-built, D-053).** K creates **`personal`** (or `org`) items — durable, so
"K's list survives the run that wrote it"; a managed run's working tickets default to **`run`**
(the original run-isolated semantics, unchanged for managed runs); and **`project`** tickets are created
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
