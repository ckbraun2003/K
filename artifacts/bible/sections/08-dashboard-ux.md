---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-07-10
---

The dashboard is the **window into the agent organization** (§03) — held to product quality, not
internal-tool quality. It is re-framed from *an operator driving a deck of tools* to *a user
directing an org*: the home is a friendly conversation with **K**, and everything else is grouped
into **Direct** (shape the org and its work) and **Observe** (watch what it did). IA decision
**D-024** (evolve-visual + Direct/Observe IA) supersedes the *IA* of D-006 and D-013 while keeping
their density, hero-only-glass, and mono-numeral discipline; decision **D-026** then *refines* D-024
with a UX-simplification pass — **one front door** (K is the only dispatch surface; per-screen `⚡` =
a scoped prefill of the K composer), **one org-status home** (Chief), **compose-is-confirm + undo**
(a full confirm-card only on escalation), a **unified scoped work-item model**, and de-duplicated
metrics, trees, and authority panels.

> **Status.** The **K-home landing** (P5.1f), **Chief** (P5.2a/b), **Orchestrators + detail**
> (P5.3a), **Workflows + detail** and the **Settings org-default authority/MCP panel** (P5.3b) all
> **ship**; the **Direct / Observe** sidebar regroup landed with K-home (P5.1f). **P5.7 (C1 + C2,
> 2026-07-02)** brought the surfaces to *pragmatic parity* with the approved demo — K-home secretary
> cards + composer power controls, Chief actuation (hand-work / reassign / stop), per-lead health
> lines + the effective-model chip, the workflow launcher, breadcrumbs, and live WS invalidation
> (details in each block below). The surfaces they reorganize (Runs + rich console, Graph, Metrics,
> Routing, Terminal, Settings, the 7 project tabs) **exist today**; this section is a
> *spec + as-built*, and the older observability implementation history (Phases G / H / 4) lives in
> §13 Observability → *Implementation history*.

## Frame — four persistent zones

```
┌──┬─────────────────────────────────────────────────┐
│❖│  ⌘K Ask K / jump anywhere…           ● core ok  │  command bar
│☺ ├─────────────────────────────────────────────────┤
│♚ │                                                 │
│❖ │                   STAGE                         │  swappable per
│⟲ │   (K-home · orchestrator · workflow · runs …)   │  destination
│▦ ├─────────────────────────────────────────────────┤
│▶ │ ● Frontend: refactor TasksTab 3/4 · ● PR #42    │  activity strip
│◉∿│                       2 running now · pause-all ⏸│  (live-only)
└──┴─────────────────────────────────────────────────┘
```

The shell stays: a collapsible **labeled sidebar**, the **⌘K command bar**, a **swappable stage**,
and an always-visible **activity strip**. What changes is the sidebar's grouping and the default
landing.

### Sidebar IA — two groups + footer

The flat destination list is regrouped into **Direct** and **Observe**, with Settings/Help in the
footer. **K-home is the default landing.**

| Group | Destination | Purpose |
|-------|-------------|---------|
| **Direct** | ☺ **K — home** *(landing)* | the friendly chat with K: ask, schedule, capture notes/tasks, kick off engineering work |
| | ♚ **Chief** | the single org-status home: objectives, one whole-org delegation tree, autonomous-wake history, and a thin health line linking to Metrics / Projects |
| | ❖ **Orchestrators** | the roster of leads (Frontend · Backend · Systems · Security · Network) as **slim cards** (name · hue · status · health · Open) |
| | ❖ **Orchestrator detail** | one lead: charter + skills + tools + MCP + memory **editors**, the **per-lead authority override** panel (inherits the org default unless overridden), and the one-lead delegation tree |
| | ⟲ **Workflows** | the named workflow definitions (implement+review, …) |
| | ⟲ **Workflow detail** | one definition: its role sequence, prompt scaffold, scope flag |
| | ▦ **Projects** | the fleet; each opens its 7-tab workspace |
| **Observe** | ▶ **Runs** | live + past runs with the rich console |
| | ◉ **Graph** | fleet + per-project 3D knowledge graphs |
| | ∿ **Metrics** | tokens / cost / run trends |
| | ⇄ **Routing** | model-routing outcomes |
| | ⊨ **Evals** | agent & skill behavioral evals + baselines (pass-rate / discrimination / regression; gated Run) |
| | `>_` **Terminal** | the guarded web terminal (default-off) |
| **Footer** | ⚙ **Settings** · ❔ **Help** | auth/status + CLAUDE.md editor + the **org-default** authority/MCP panel (per-lead overrides live on Orchestrator detail); help opens this bible |

The active destination sits on a translucent-blush glass pill; `g` + first letter jumps; the rail
collapses to icons-only (state persisted). **Docs is not a top-level destination** — artifacts live
per-project in the workspace Artifacts tab, and the bible stays reachable via footer Help.

> **As-built (P5.1f).** The regroup ships in `web/src/shell/Sidebar.tsx`: a `group?: 'direct' |
> 'observe'` field is added **orthogonally to** the existing `section` field (`primary`/`footer`/
> `hidden`), which stays the source of truth for `NAV_DESTINATIONS`, `TopBar` label resolution, and
> the **destination↔chord invariant test** (`web/test/chords.test.ts`, unchanged). **Direct** = K ·
> Chief · Orchestrators · Workflows · Projects · Skills · Memory; **Observe** = Runs · Graph · Metrics
> · Routing · Evals · Terminal; **footer** = Settings · Help. (Skills + Memory — authoring/governance
> surfaces not tabled in D-024 — sit in Direct as "shape the org"; Evals sits in Observe per this
> section's table.) Expanded rail shows "Direct"/"Observe" labels; collapsed rail shows a hairline
> divider between the clusters. **K-home is the default `home` view** — the `home` route id is kept
> (so every chord/route/test that references it is unchanged) and the destination is relabeled "K".

### ⌘K / K — the one front door

**K (⌘K) is the only dispatch surface.** One input, two behaviors ranked in a single result list:
- **Ask / dispatch:** natural language → **K routes it** — logistics it handles itself, an
  engineering goal to the **Chief**, or a scoped job to a **specific lead** — and shows the chosen
  **route inline before send** ("→ Frontend lead · sonnet · ~small"). **Send** fires immediately with
  a **5 s undo** toast; a full confirm-card appears **only on escalation** (T3 authority /
  cross-project / a destructive kill·delete·reassign). *Force a specific lead* is an **advanced
  toggle**, not the default. Inside a workspace the composer is project-scoped.
- **Navigate:** fuzzy jump to any project, run, PR, work-item, orchestrator, workflow, or bible section.

**Ask-K composer — DELIVERED P5.1c2 in ⌘K.** A plain (non-`@`) query is K's front door: the row
reads *Ask K: …* with the `routeForMessage` preview shown **inline as you type** (and again on the
row); **Enter sends immediately** (compose-is-confirm, no card — D-026) via `api.k.ask`, opens the
run console on the returned `runId`, and raises a **5 s undo** toast whose *Undo* kills that run
within the window. Voice rides the same box (MicButton transcript → composer text). `@project`
queries still use the compose-and-confirm card → `api.runs.start`. **The K-home landing —
work-items · recent feed · glance-to-Chief — ships in P5.1f** (below); the send/undo orchestration
is now a shared `useAskK` hook (`web/src/lib/useAskK.ts`) that both ⌘K and K-home drive identically.

**Every per-screen `⚡` is a scoped prefill of this one composer** — it opens K pre-targeted to the
lead / project / symbol in view (and pre-fills the route), never an independent dispatch surface.
There is exactly one place work is dispatched.

### Activity strip

**Live-only** — what is **running right now** across all tiers, with pulsing status dots, one-line
progress, last completed action, and pause-all. Click any entry → its full run console. **Day totals
($ / runs / tokens) live only in Metrics** — the strip never prints aggregates (metric uniqueness:
every number appears in exactly one place).

## Direct — the org surfaces (BUILT — Phase 5, parity P5.7)

### K — home (the landing)

The friendly face, kept **calm** — **no metrics bar**. The layout is just:
- a **greeting**,
- **one Ask-K composer** (the front door above) with a **single Send** and a **push-to-talk mic**
  (hold to dictate; the transcript lands in the box for review before send, D-031) — no
  direct-vs-Hand-to-Chief split; K decides the route and shows it inline,
- **your work-items** — the personal / org items K tracks for you (the unified work-item model, §04),
- a **light recent feed** — the last few things that happened, and
- **one one-line glance** linking to **Chief** for full org status (not a per-tier status grid).

K never shows code-authority controls (it has none). A dispatched engineering request just sends with
the **5 s undo** toast and an inline route; results bubble back into the conversation with a
**toast-with-link** to the run. The richer org status lives on Chief, one click away.

> **What ships (P5.1f, brought to parity in P5.7 C1/C2).** `web/src/pages/KHome.tsx` (the default
> `home` view) renders, top-to-bottom: a **time-aware greeting** (no hardcoded operator name); a
> **one-line glance-to-Chief** (`leadsActive` + objectives-in-flight, linking to Chief); the
> **Ask-K composer** — an input + push-to-talk **MicButton** + inline `routeForMessage` preview +
> **power controls** (a **model override** picker over the `KNOWN_MODELS` registry and a **forced
> route** selector — `KAskBody.{model, forceRoute}`, §03) — wired to the shared **`useAskK`** hook;
> a **3-card glance grid** — **Notes** and **Schedule** (read-only cards over the durable logistics
> store via the thin `GET /api/k/notes` / `GET /api/k/schedule` routes; overdue pending reminders
> deliberately included) and **Your work** — **real durable personal work items**
> (`GET/POST/PATCH /api/k/work-items`: checkbox toggle open↔done, an inline add composer, honest
> empty/error states — the earlier org-objectives stopgap and its "coming soon" caption are gone);
> and a **recent feed** of the latest runs (View-run links). **K-home does NOT auto-navigate on
> send** (P5.7 C1): the **5 s undo** toast stays in place with a *View run →* link (navigate only on
> click), and a second send inside the window restarts the countdown for the new run — ⌘K keeps its
> open-the-console behavior (`useAskK`'s `navigateOnSend` is caller-chosen). The demo's
> "Interactive" checkbox is **deliberately absent** for K sends — the K path is already interactive
> by design, so the control would map to nothing.

### Chief — the single org-status home

The one place to see the whole org at once: the active **objectives**, **one whole-org delegation
tree** (the shared DelegationTree component below, scoped to every lead), the **autonomous-wake
history** (schedule/event triggers that woke the org), and a **thin health line** that links out to
**Metrics** and **Projects**. It is the org-status home — **not a full health strip** (those numbers
live in Metrics) and **not a second authority panel** (the authority map lives in Settings /
Orchestrator detail). Reports the Chief produces for the user surface here and on K-home.

> **As-built actuation (P5.7 C2).** The Chief page is no longer watch-only:
> - The whole-org **DelegationTree gains inspector actions** (a `renderActions` prop): **Open
>   lead** (jump to the lead's control plane), **View run** (the node's backing run console), and
>   **Stop run** on a live/queued lead node — ConfirmDialog-gated (destructive) over the existing
>   kill route, offered precisely because a live lead run blocks reassign.
> - A **hand-Chief-work composer** — a forced `chief` route through the same shared front door
>   (`useAskK` + `forceRoute:'chief'`), with an honest static "will hand to Chief" caption.
> - **Operator reassign** — each objective row can move to another lead:
>   `PATCH /api/chief/assignments/:id` (confirm-carded; `409` while the current lead run is live or
>   a dispatch intent is in flight — stop first, then reassign; `400` same-lead; clears the stale
>   `lead_run_id`; files a durable mgmt audit report). Unwedged by the D-060 liveness-derivation
>   fix (§03).

### Orchestrators + orchestrator detail

The **Orchestrators** page is the roster of leads as **slim cards** — name · hue · status · health ·
**Open** — everything else lives on detail. **Orchestrator detail** is the richest org surface and
carries, as first-class panels:
- **Editors** for the lead's **charter**, **skills**, **tools**, **MCP servers**, and **memory**
  (the approved lessons of §04) — this is where a discipline is actually configured.
- A **per-lead authority override panel** — shows exactly which tools/skills/MCPs this lead may touch
  and why, framed as **"inherits the org default unless overridden"** (the org-default map is edited
  in **Settings**; this panel records only the deltas). This is the control plane made legible without
  duplicating it.
- The **one-lead delegation tree** for the lead's active run (controller → implementer →
  spec-review / quality-review) — the **same DelegationTree component** the Chief uses at whole-org
  scope, here scoped to one lead, reusing the runtime sub-agent tree (§13).

> **What ships today (P5.3a).** The **Orchestrators roster** (`web/src/pages/OrchestratorsPage.tsx`,
> one batched `GET /api/orchestrators`) and **Orchestrator detail** (`OrchestratorDetailPage.tsx`,
> `GET /api/orchestrators/:id`) are built. Detail carries the tabbed **skills / tools / MCP·Authority**
> editors + a read-only charter and the lead's approved-lessons memory, and reuses the **one-lead
> `DelegationTree`** via `leadNode` (no re-derivation). Every edit is a `PATCH /api/orchestrators/:id`
> that goes through `profiles.ts::updateProfile` — so the **mcp↔allowlist grant guard stays
> fail-closed**: mounting an ungranted MCP server is rejected `400` and the row is unchanged (D-043).
> The route lifts the Chief's per-lead assembly into `routes/org-shared.ts` (`isLead` / `assembleLead`
> + a slim `rosterVitals`), so both surfaces derive a lead identically. **Now built (P5.3b, D-047):** the
> `workflow_definitions` table + Workflows list/detail UI and the **Settings org-default** authority/MCP
> panel — the org-default the per-lead overrides inherit from.
>
> **P5.7 parity (C1 + C2).** Roster cards and the detail header carry a **per-lead recent-health
> line** — "S/T recent OK" with an amber tint on failures, derived from the last 10 `agent_runs`
> activations (the terminal-status truth; nothing invented when there is no history — the demo's
> health *scores/bands* were consciously not built). The detail header renders an **`effectiveModel`
> chip** — "override: `<model>`" vs "runtime default (`<model>`)" — matching the D-056 resolution
> order honestly. The **Skills and Tools editors gain add-by-name affordances** with org-default
> datalist suggestions (a removed grant is recoverable in place; adds are still ceiling-checked
> fail-closed server-side, D-054); the "MCP · Authority" tab is renamed **MCP servers**; the Memory
> tab links out to the Memory page (no dead end); and the roster cards drop the identical,
> meaningless tier chip.

### Workflows + workflow detail

**Workflows** lists the named definitions; **workflow detail** shows one definition's role sequence,
prompt scaffold, and cross-project scope flag. The previously-abstract standalone "Workflows
diagram" is **folded into** orchestrator/workflow detail, where it has real context (a lead actually
running it) rather than floating on its own.

> **What ships (P5.3b, D-047).** `WorkflowsPage`'s **Defined** tab is now a **Definitions list +
> preview** (one batched `GET /api/workflows`) — each row shows the name + role chain; the preview
> renders the role pipeline + cross-project badge with an **Open** into `WorkflowDetailPage`
> (`GET /api/workflows/:id`). Detail edits the **name**, **prompt scaffold** (`{{CHECKLIST}}`-tokened),
> and **cross-project** toggle via `PATCH /api/workflows/:id` (read-merge-write; a duplicate name is a
> `400`, roles are read-only for now). The **Run tree** tab is unchanged. In **Settings**, an
> **Org-default authority** section reads/edits the `default-orchestrator` grant (skills / tools /
> MCP) via `GET`/`PATCH /api/org-default` — grant-guarded fail-closed exactly like the per-lead
> orchestrators PATCH — so the "inherits the org default unless overridden" panel above has a real
> source to inherit from.
>
> **P5.7 C2 — the launcher.** `WorkflowDetailPage` gains a **"Run this workflow"** dialog: pick a
> project → its open tasks → dispatch. The task-dispatch route accepts an optional **`workflowId`**
> and renders *that* definition's scaffold through the existing `renderWorkflowPrompt` seam
> (unknown id → `400`, validate-before-mutate — §04). The **Run tree** tab's picker now defaults to
> a **workflow-only run filter** (fed by the new `GET /api/workflows/runs`) with an all-runs
> toggle; deep links default to all.

### Skills — the capability catalog (BUILT — host-integration program, D-069..D-071)

The **Skills** destination (D-024 originally planned to fold it away; the host-integration
program made it first-class instead) is **one destination, four routed tabs**:

| Tab | Content |
|-----|---------|
| **Catalog** (`#/skills`, default) | every mountable skill — K-native + discovered host assets — with a **source badge** (k · global · project · plugin; the plugin badge names the plugin), a **model-compat badge** (universal / claude-only / mcp-dependent), an **est-token chip**, the K-scoped **enable** toggle, a SKILL.md preview, and mountedBy chips; filters + search, a **Rescan** button, and a **warnings banner** (unreadable host dirs, malformed SKILL.md) |
| **MCP** (`#/skills/mcp`) | tier-template servers (provenance `k`, born trusted, not toggleable) + discovered host servers behind the **TrustDialog** flow — review the full command / args / env **names** before "Trust & enable" — plus the explicit **probe** for tool-count/token estimates |
| **Hooks** (`#/skills/hooks`) | read-only host-hook visibility with a not-executed-by-K banner (K runs execute only K's vendored hooks) |
| **Automations** (`#/skills/automations`) | the pre-existing K automation registry (triggers, schedules, eval history), extracted verbatim as `AutomationsTab` |

A **CapabilityStatRow** totals strip heads all four tabs — `Enabled skills: n · ~Xk tok — MCP: m
servers · ~Yk tok — Total context overhead: ~Zk tok` — with an "estimates, not billed tokens"
tooltip; entries without an estimate (e.g. an unprobed MCP server) are counted and footnoted,
never silently dropped. The catalog invalidates live on the `capabilities_update` WS event (§13).

**CapabilityPicker.** The orchestrator-detail **Skills** and **MCP servers** tabs and the Settings
**org-default** panel assign discovered capabilities through a shared ARIA-combobox
**CapabilityPicker** — source badge + token chip per item, a per-profile token subtotal, disabled
entries grayed with a catalog deep-link. The **Tools** tab keeps `AuthorityList` (allowlist
patterns, not catalog entries), and **K / Chief stay read-only by design** (§03).

**Skill Creator** (`#/skill-creator`, a hidden route reached from the catalog): DraftList +
BriefForm + a draft workspace — StatusHeader with run links, honestly labeled **"agent-generated
draft — not saved"** vs **"saved to K library"** — SkillDraftEditor, RefinePanel, EvalPanel (the
existing eval badges), SaveBar. Lifecycle in §04.

**RunConsole runtime badge.** A run on a local model declares its engine honestly — **"local ·
tools"** (the D-072 tool loop with tools advertised) vs **"local · prompt-only"** (degraded in
place: no tool support, skills inlined) — fed by the truthful run-start system event (§13).

### Projects — workspace, 7 tabs

A project opens into its workspace (unchanged in shape):

| Tab | Content |
|-----|---------|
| **Overview** | health score breakdown, latest verification summary, recent runs, open PRs, bible freshness, quick actions |
| **Knowledge Graph** | per-project 3D graph, first-class (below) |
| **Runs** | this project's runs: live consoles, history, replay from the event log |
| **Tasks** | project tickets (`work_items`, scope `project` — §04), optional GitHub Issues sync, multi-select → run a delegation workflow |
| **PRs & CI** | open PRs with check status, diff links, Actions run history |
| **Verification** | report timeline, findings by severity, fixes applied, re-run button |
| **Artifacts** | this project's OWN artifacts as a gallery (only `project-<id>-*`, not the harness globals — F-038), each in a sandboxed iframe; a regular artifact edits as markdown, a **bible edits per SECTION** with source-of-truth writeback + recompile, staying in the project's own dir (D-065) |

## Observe — the watch surfaces (today)

- **Runs + rich run console.** Runs render as **structured, collapsed-by-default** items — commands
  (`$ …` with output on expand), file ops (Write preview, Edit/MultiEdit diff hunks), and delegated
  sub-agents (type + label, full prompt + result on expand). A **Console ↔ Timeline** toggle exposes
  the replayable per-seq event log. Interactive runs show an **answer box** (ask → answer → continue)
  with **End session** and **Compact context**, plus a **`ctx X / Y · Z%`** pressure meter. (Internals
  in §13.)
- **Graph (3D).** Fleet + per-project knowledge graphs (below).
- **Metrics.** Tokens / cost / run trends over time (stacked-SVG charts), plus KPI tiles and
  gap-audit breakdowns (W9): **cost-by-lead** (`groupBy=lead` — each run resolved to its lead via the
  latest orchestrator `agent_runs` activation; no-activation → `unassigned`), an **error-rate** KPI
  (the exact complement of success rate), **latency p50 / p95** (R-7 interpolation over the
  parked-excluded active latency), and **success-rate + latency day trends**
  (`GET /api/metrics/quality`; a day with no terminal/latency data is a null **gap**, never NaN).
  Latency everywhere **excludes time a run sat parked** at `awaiting_input` (the shared
  `activeLatencyMs` rule), so it reflects processing time, not operator think-time; an operator-**killed**
  run is **excluded from the terminal denominator** — neither a success nor a failure. (Retry-rate is
  documented UNAVAILABLE — no retry tracking exists; nothing fabricated.)
- **Routing.** Model-routing outcomes — cost / latency / success by provider+model, over the same
  parked-excluded active latency and killed-excluded success rate.
- **Evals.** The behavioral eval subsystem (§07): systems, runs with progress, a per-system pass-rate /
  discrimination / regression report, the raw results table, and a **gated Run** (dry by default — a real
  token-spending run requires an explicit opt-in that resets on every dialog open). (Internals in §07.)
- **Terminal.** A guarded `node-pty` web terminal (default-off; scoped `TERMINAL_TOKEN`).

## Visibility (P3)

Phase 3 makes the org's *history* legible without adding a write path — every surface below is a
**derivation** over data the harness already stores (the read-time discipline of the D-081 Inbox).

### Run Narrative card (E-08, D-086)

Every run gets a **Run Narrative** — a "what this run did" card that **mounts in the run console**.
Its **deterministic fields** — goal, outcome, files touched, verification, cost — are derived from
the run's own events and **always render**. Below them, physically separated, sit **at most three
Decisions and three Risks bullets** from the **local model**, auto-attempted on open and **labeled
"generated"** so model prose can never read as measured fact. If the local model is unreachable or
its output won't parse, the bullets **gracefully omit** with a subtle note (facts-only); a bounded
20 s abort guarantees the card's GET never blocks on a stuck stream.

### Org Timeline (E-09, D-085)

A single **Org Timeline** — **one feed**, rendered as git-log-style **iconographic rows** — is the
org's activity history. **Kind filter chips carry counts** and narrow the view in place. An
**opt-in digest** inlines the Run Narrative card per event (**capped at 12** so the fan-out stays
bounded), and an honest **"showing N of M events"** signal never hides truncation. **K-home's
"recent" reads the same feed**, so the home glance and the Timeline view cannot disagree. The
**ActivityStrip is deliberately NOT re-pointed** — it stays the **live-runs widget** (complete,
uncapped coverage of every non-terminal run), because the capped historical feed would silently
drop parked runs. (Feed architecture + the measured cost lens are in §13.)

### Relative weight bands (E-13, D-087)

The capability-catalog **token chips become relative light / medium / heavy weight bands** — a
context-cost hint derived from token counts, **never a dollar figure**. The measured cost roll-ups
that consume real `cost_usd` live on Metrics and in §13.

### Single HealthRubric (E-12, D-088)

The ~5 drifting copies of health-score → color/label logic fold into **one `healthRubric`** — the
canonical thresholds **≥75 healthy / ≥50 warn / else critical / null unknown** — consumed by every
web health surface (ProjectCard, FleetGraph, ProjectVerification, ProjectWorkspace, verify). As an
**intended** consequence, **ProjectCard now shows a colored health dot / band** in place of the old
flat numeric score. (The server-side `bible.ts liveHealth` 80-threshold is a separate concern, left
unchanged.)

### Glossary tooltips (E-12, D-088)

Terms defined in the **§14 Glossary** render an inline **`GlossaryTerm` tooltip** wherever they
appear in the UI. The term dictionary is **extracted at `pnpm bible` compile time** into a committed
generated module (`web/src/generated/glossary.ts`), so tooltips stay in lockstep with the living
spec at zero runtime cost, guarded by a drift test.

## Approvals Inbox + notifications (Human Gates — Phase 2)

- **The Approvals Inbox is THE "needs-YOU" surface.** One place that answers "what is waiting on
  *me*?" It is a **UNION over five sources** — **plan approvals** (runs parked at `awaiting_plan`),
  **`awaiting_input` parks** (interactive runs waiting on your turn), **pending lessons** (the
  memory-review queue of §04), **untrusted MCP** (servers awaiting a trust decision), and
  **review-ready runs** (finished runs with a diff to review). It is **a query, never a table**
  (D-081): each item is read live from its own authoritative source, so the Inbox can never drift
  out of sync with the surfaces it aggregates.
- **Dismissal semantics.** A review-ready run is dismissed by a **stamp-once `runs.reviewed_at`**
  (backfilled at schema v10) — once you have reviewed it, the card stays gone. An untrusted-MCP card
  is dismissed by an **`inbox_dismissed_hash` pinned to the server's `config_hash`**: dismissing pins
  the hash you saw, and if the MCP config later **drifts** (a new `config_hash`), the card
  **re-surfaces** so a changed server is re-reviewed rather than silently trusted.
- **Notifications — rules and channels.** A seeded **`notification_rules`** table maps an **event
  key → channel** (in-app and/or browser). The **in-app center** is the **durable** log — it persists
  what happened so nothing is missed while you were away. The **browser leg is transient**: the
  engine dedupes on **status transitions** (not on every event), and a browser notification **raises
  only when the tab is hidden AND permission has been granted** (the permission prompt is
  **gesture-requested**, since browsers reject un-gestured permission requests). With permission
  denied or the tab focused, the in-app center still records everything — the browser leg is purely
  an optional attention-grab.

## Settings + Help

- **Settings** — provider/auth **status** cards (claude / ollama / voice / github / auth posture, **no
  secrets**), the **guarded global CLAUDE.md editor** (fixed path, gitnexus block preserved, atomic
  write, backups, confirm-before-save), and the **org-default authority / MCP panel** (BUILT —
  P5.3b, D-047; enforced at synthesis since P5.7, D-054) —
  the editable source of the **org-default** tier → tools/skills/MCPs map. **Per-lead overrides** to
  that default live on **Orchestrator detail** ("inherits org default unless overridden"); Settings
  owns the default, detail owns the delta — the map is edited in exactly one place per scope.
- **Claude default model** *(DELIVERED 5.5)* — a Settings picker sets the **global Claude default
  model** the router uses for Claude runs. It is `app_config`-managed (validated against the known
  registry), so a change applies to the **next run with no restart** — the model is no longer an
  env-frozen constant. The per-run ⌘K picker still overrides it for a single dispatch.
- **Local models (Ollama)** *(D-030, DELIVERED 5.5)* — a model-management surface in Settings: the
  **installed** models with an **active** badge + an **active-model selector** (applies live, **no
  restart**) and per-model **Remove**, plus a **curated catalog** with sizes and a **"fits on disk?"**
  badge + **Pull** with a **live progress bar over the EventBus→WS wire** (`ollama_pull`). The active
  selection is what the router uses whenever it routes to Ollama, and the **⌘K dispatch picker**
  reflects that live active model. *Still planned:* an advanced **pull-any-tag** box and a cross-link
  to **Routing** for per-model outcomes.
- **Voice transcription** *(D-031, DELIVERED 5.4)* — a reusable **push-to-talk `MicButton`** wired into
  the **⌘K command bar** and the **run-console HITL reply box** (the K composer drops in the same button
  once P5.1 lands): hold to record (browser `MediaRecorder`) → release → `POST /api/transcribe` (core
  proxies to a local Whisper server; the **browser holds no key**) → the transcript lands as **ordinary
  text** in the target input for review before send. Settings shows a **read-only voice status card**
  (Whisper reachable · model · baseUrl, mirroring the provider status cards). Voice is enabled via
  `ENABLE_VOICE` — there is **no runtime toggle** (it needs a local Whisper server); with voice off the
  mic is disabled with a tooltip, and a **denied mic or unreachable Whisper degrades cleanly to the
  keyboard** (nothing lands on failure). Audio is transcribed locally and never leaves the box.
- **Help** — opens this bible (and the `g` chord).

## Universal interaction patterns

- **Compose-is-confirm + undo.** A normal dispatch **sends straight from the composer** with the route
  shown inline and a **5 s undo** toast — no confirm step for the common case. A **full confirm-card**
  (target · model · scope) appears **only on escalation**: a **T3-authority** action, a
  **cross-project** run, or a **destructive** kill · delete · reassign.
- **Toast-with-link is universal.** On success every action drops a toast with a **direct link** to
  the thing it created (the run console, the PR, the report) — no result has to be hunted for, and no
  action fires silently (the undo toast is the confirmation for the low-friction path).
- **Metric uniqueness.** Every metric is printed in **exactly one place** — live state in the
  activity strip, day totals and trends in Metrics, health on Chief's thin line / project Overview.
  No surface re-prints another's numbers.
- Live state always streams over the existing WebSocket; the UI never blocks on a poll. **The org
  views are live too (P5.7 C1):** `run_update` WS events also invalidate the chief-org /
  orchestrators / orchestrator-detail queries — throttled leading+trailing at 250 ms
  (`lib/live-invalidate.ts`) so a chatty run can't stampede refetches.
- **Breadcrumbs (P5.7 C1).** The TopBar renders real breadcrumbs for the param-routed detail views
  — *Orchestrators › \<name\>*, *Workflows › \<name\>*, *Projects › \<name\>* — reusing the owning
  pages' exact query keys so react-query dedupes the read.
- **Focus + a11y (P5.7 C1).** The ⌘K palette carries `role="dialog"`/`aria-modal`/label;
  ConfirmDialog and the evals RunDialog get a **focus trap** (`lib/useFocusTrap.ts`,
  container-boundary safe). The 6-file hardcoded on-accent hex is replaced by the `--on-accent`
  token (the D-013 WCAG rule, tokenized).

## Knowledge graph spec (fleet + per-project)

The **Graph (3D) is the structural code / fleet graph** — modules · files · symbols · dependencies —
**not a second delegation view**. Delegation (who is working for whom) is owned by the one
DelegationTree component (Chief whole-org · Orchestrator-detail one-lead); the two never overlap.

- **Renderer:** `react-force-graph-3d` (Three.js/WebGL) with a collision force so nodes don't
  overlap; each surface is wrapped in an error boundary so a context-creation failure degrades to a
  fallback instead of blanking the route. **Always import the renderer subpackage** (`-3d` / `-2d`),
  never the `react-force-graph` aggregate — it references a non-existent global `AFRAME` and throws
  at module-eval time, blanking every route (guarded by a static import test).
- **Data source:** GitNexus indexes per project (Phase 2); fleet edges from manifest/dependency scanning.
- **Level of detail:** modules → files → symbols, plus a *hot paths* overlay (recent run activity).
  Double-click expands a node one level; breadcrumb chips track depth.
- **Node inspector** (right panel on select): live facts — file/symbol counts, failing tests
  originating here, last-touched-by (run/PR), bible links — and **dispatch actions**: "fix failing
  tests in this module", "explain this subsystem", "open impact analysis".
- **Interactions:** scroll = zoom, drag = pan, `f` = fit, search filters in place by dimming
  non-matches (never re-layouts under the user).
- Health/status colors the graph: failing modules glow red, untested amber, healthy blush — the
  graph is a *diagnostic surface*, not decoration. Nodes carry a soft glow + zoom-gated label; edges
  render in semi-transparent sky-blue so relationships read on the midnight canvas.

## Design tokens (vivid midnight-glass — evolve, D-024)

The language **evolves** D-013's vivid midnight-glass rather than replacing it: same base palette,
same hero-only glass and mono numerals, but **warmer and friendlier on K-home** (softer surfaces,
more generous spacing, a calmer conversational layout) so the face of the org reads as approachable
while the Observe surfaces stay dense and precise. Values remain the single source in
`web/src/index.css` `:root`, mirrored into `web/tailwind.config.ts` and `core/src/ui-artifact.ts`
(the `ui-demo` inline CSS). Change all three together.

| Token | Value |
|-------|-------|
| bg / surface / raised | `#1a0f2e` / `#241640` / `#2e1b52` (midnight purple) |
| hairline border | `1px #3a2a5c` |
| text / muted | `#f4f0ff` / `#a99bc4` |
| accent — fills / active / badges | **blush** `#ff8fc0` |
| accent-hover — hover / active / focus | **sky** `#38bdf8` |
| status | `#34d399` · `#fbbf24` · `#f87171` |
| glass | bg `rgba(46,27,82,.55)` · border `rgba(255,143,192,.16)` · tint `rgba(255,143,192,.10)` · `blur(24px) saturate(180%)` |
| type | Inter 13/14px UI · JetBrains Mono for numerals, ids, code |
| radius | 18px panels · 14px controls · 10px small (rounder, liquid-glass) |
| motion | 150ms ease-out micro · 250ms stage transitions · pulse only on genuinely live elements |

**Rules:** color carries meaning or stays out (status stays green/amber/red); the accent is split —
**blush** for fills/active, **sky** for the hover/active/focus transition; **accent FILLS use dark
`--bg` text** (white on the light blush fails WCAG AA — accent-as-text only on dark surfaces); glass
is reserved for hero surfaces (command bar, dialogs, inspector, activity strip, K-home conversation,
the accent metric card) while dense data views stay opaque; every number is mono so columns of
metrics align.

## Component inventory (shadcn/ui base)

Command (⌘K) · Card · Tabs · Badge · Tooltip · Dialog (escalation confirm-cards only) · Table
(runs/PRs) · Resizable panels (graph + inspector, orchestrator editors + authority-override panel) ·
Sonner toasts (toast-with-link + the 5 s undo toast) — plus custom: MetricCard, ProjectCard,
ActivityStrip, GraphCanvas, NodeInspector, RunConsole, ToolCall (rich console), plus the PLANNED
**KChat** (the one front-door composer), **DelegationTree** (one component, reused at whole-org and
one-lead scope), AuthorityPanel (org-default in Settings · per-lead override on detail), CharterEditor,
**MicButton** (push-to-talk — DELIVERED 5.4 in ⌘K + HITL reply; drops into the composer with P5.1), a **LocalModels** manager (catalog +
pull progress + active selector), and a slim OrgCard / roster card.

## Accessibility & quality bar

Full keyboard navigation (sidebar `g` chords, `j/k` lists, ⌘K everything) · visible focus rings
(accent) · WCAG AA contrast on all text · reduced-motion respects OS setting · 60fps graph
interactions on a mid laptop; degrade node count before frame rate.
