---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-07-20
---

The dashboard is the **window into the agent organization** (§03) — held to product quality, not
internal-tool quality. **UI Simplification (D-101..D-106)** re-frames it a second time: P4's
9-item flat rail (D-096) still asked the operator to pick between near-duplicate org/insight
surfaces; this pass **folds the rail to 6 primary tabs** — **K (Home) · Personal · Agents · Runs ·
Insights · Projects** — plus a Help/Settings footer (the Continuous Agents wave later adds a
seventh, **Messages** — D-123, below), and replaces the ⌘K CommandBar palette +
Activity strip with **one Message Dock** (a composer bar on Home, a floating button everywhere
else). Every surface this section previously described **still exists**; what changed is which tab
it lives under and how the operator reaches K. IA decision **D-024** (evolve-visual +
Direct/Observe), refined by **D-026** (one front door, compose-is-confirm + undo) and flattened by
**D-096** (9-item rail), now folds again under **D-101/D-102**: **Personal absorbs Inbox + Tasks +
Chats + Memories**, **Agents absorbs Org + Skills + Pipelines** (the former Workflows), and **Home
splits into a Chat view and a widget-grid Overview view** behind one SegControl. All prior density,
hero-only-glass, and mono-numeral discipline carries forward unchanged.

> **Status.** Tasks 1-18 of the UI Simplification program **ship**: schema v11 (multi-thread K +
> user memories + home layout), the Message Dock, the 6-tab rail + redirect table, Home's
> Chat/Overview split, the 9-widget catalog + persisted grid, the Personal and Agents hubs, and the
> retirement sweep (CommandBar/ActivityStrip/InboxPage/OrgPage-as-toplevel/SkillsPage-as-toplevel/
> WorkflowsPage-as-toplevel all removed as standalone routes). The surfaces these hubs reorganize —
> the rich Runs console, Insights' 4 tabs, the 7 project tabs, orchestrator detail, Settings — carry
> their P4/P5 content forward; this section is a *spec + as-built*, and the older observability
> implementation history lives in §13 Observability → *Implementation history*.

## Frame — three persistent zones

```
┌──┬─────────────────────────────────────────────────┐
│K │                                                 │
│✉ │                                                 │
│☑ │                                                 │
│♛ │                   STAGE                         │  swappable per
│▶ │        (home · personal · agents · runs …)      │  destination
│∿ │                                                 │
│▦ ├─────────────────────────────────────────────────┤
│  │ ⚡ Message K…                          🎙  Send  │  Message Dock (bar,
│❔⚙│                                                  │  Home only)
└──┴─────────────────────────────────────────────────┘
                                              ⬤K   ←  Message Dock (float,
                                                       everywhere else)
```

The shell is now just three zones: a collapsible **labeled sidebar**, a **swappable stage**, and the
**Message Dock**. The old fourth zone — the ⌘K command bar docked at the top plus a separate
always-visible Activity strip at the bottom — is gone; both collapsed into the one Dock (below).

### Sidebar IA — the 6-tab rail (D-101; a 7th, Messages, added by D-123)

**`KNOWN_VIEWS`** (`web/src/lib/route.ts`) is now 15 entries: the **7 primary destinations**
(D-123 added `messages` to D-101's six) + `settings` (Help, the other footer rail entry, deep-links
into `docs` and adds no view of its own), plus `orchestrator` / `project` / `verify` / `docs` /
`skill-creator` / `timeline` / `pr-review` (drill-ins reached from a hub, never rail buttons
themselves). Every view string this restructure removed keeps a `VIEW_REDIRECTS` entry (Retirements
& redirects, below) — the redirect **replaces** the history entry (`history.replaceState`, no
Back-trap), and `resolveRoute` is idempotent (a canonical view is never a redirect key).

| Rail | Route | Absorbs | Purpose |
|------|-------|---------|---------|
| ⌂ **K** *(landing)* | `#/` | K-home | **Chat** with K (default) or **Overview** — a SegControl toggle, not two routes |
| ✉ **Messages** | `#/messages` | Personal → Chats | **every conversation in one place** (D-123, below) — K's threads first, then one conversation per durable agent, with unread badges + thread management |
| ☑ **Personal** | `#/personal` | Inbox · Tasks · Memories | your needs-you queue, work items, and durable memories — 3 tabs (Chats folded into Messages, D-123) |
| ♛ **Agents** | `#/agents` | Org · Skills · Workflows | the agent organization — **Org** (Roster/Tree/Graph), **Catalog** (Skills/MCP/Hooks/Sub Agents), **Automations** (Library/Runs/Schedules — the unified pipeline surface) — 3 tabs *(D-120 restructured the tab names/shape; superseded D-101's Org·Skills·Pipelines split — see below)* |
| ▶ **Runs** | `#/runs` | — | live + past runs with the rich console, now a plain master-detail (no Workflows sub-tab — Agents → Automations → Runs owns pipeline-run visibility now) |
| ∿ **Insights** | `#/insights` | Metrics · Routing · Evals | **4 tabs** — Overview (deterministic deltas + anomalies) · Charts · Routing · Evals |
| ▦ **Projects** | `#/projects` | — | the fleet; each opens its 7-tab workspace |
| **Footer** | ❔ **Help** · ⚙ **Settings** | Terminal | Help opens the in-app multi-page guide (D-116, below) — no longer a bible deep-link; Settings hosts diagnostics terminal, CLAUDE.md editor, org-default authority/MCP panel |

The active destination sits on a translucent-blush glass pill (`aria-current="page"`); `g` + first
letter jumps (`web/src/lib/chords.ts`: `h`→Home, `m`→Messages, `u`→Personal, `a`→Agents, `r`→Runs,
`n`→Insights, `p`→Projects, `d`→Docs, `,`→Settings); the rail collapses to
icons-only (state persisted in `localStorage`). Personal carries a needs-you count badge and Runs
carries an active/parked-runs badge, both sharing the same query keys their pages use (zero extra
fetches). **Docs is not a top-level destination** — reachable via footer Help, edit-in-place per
section.

> **As-built.** `web/src/shell/Sidebar.tsx`'s `DESTINATIONS` array is the 7 primary (Messages sits
> between K and Personal) + 2 footer + 3
> hidden (`docs`, `skill-creator`, `timeline` — kept only so `TopBar` can resolve a label for a view
> reached indirectly). `Shell.tsx` routes `home → HomePage`, `messages → MessagesPage(threadId)`,
> `personal → PersonalPage(tab)`,
> `agents → AgentsPage(tab, sub)`, `runs → RunsPage(runId)`, `insights → InsightsPage(tab)`,
> `projects → ProjectsPage`, and drops the old standalone `Chief` / `Orchestrators` / `Metrics` /
> `Routing` / `FleetGraph` / `Workflows` / `Evals` / `Inbox` / `Memory` / `Terminal` branches
> entirely. The `home` route id is unchanged from P4, so every chord/route/test that references it
> still holds.

## Message Dock — the one front door (D-102)

**One `MessageDock` component (`web/src/shell/MessageDock.tsx`) replaces both the ⌘K CommandBar
palette and the live-only Activity strip.** It renders in two variants sharing one `<Composer/>`:

- **Bar** (`variant="bar"`, Home only) — a persistent composer docked at the bottom of the stage:
  input + push-to-talk mic + K's inline route preview + Send. Mounted at `Shell` level so it
  survives the Chat↔Overview SegControl toggle.
- **Float** (`variant="float"`, every other route) — a fixed circular **FAB** carrying an
  inbox-count badge; click (or **Ctrl/Cmd+K**, unchanged chord — wired via `focusDock`/`dock-bus.ts`)
  opens a focus-trapped overlay: a **thread picker** (recent K threads + New chat) beside the same
  composer, Escape returns focus to the FAB.

**Dispatch semantics (unchanged front-door contract, just one visual home now):**
- Plain text routes through K — `routeForMessage` shows the chosen route **inline before send**
  ("→ Frontend lead · sonnet · ~small"); **Enter/Send fires immediately** (compose-is-confirm, no
  card) via the shared `useAskK` hook, and a **5 s undo toast** (`dock-undo-toast`) lets the operator
  kill the just-started run within the window.
- An explicit **`@project`** target (`routeForTarget`, which returns `null` for `@`-prefixed text so
  K never mis-routes it) escalates to the full **"Compose & dispatch" confirm-card** — mutually
  exclusive **Interactive / Plan-first** checkboxes, **Model** and **Scope** fields — because a
  manually-targeted cross-project dispatch is exactly the escalation case D-026 reserves a confirm
  step for.
- **K threads are lazily created on first send** (no empty thread rows); per-thread drafts persist
  in a `Map` so switching threads never drops in-progress text.
- Every per-screen `⚡` is still a **scoped prefill** of this one composer (pre-targeted lead/project/
  symbol, pre-filled route) — there remains exactly one place work is dispatched.

**Live-run visibility**, previously the Activity strip's job, now lives where the metric-uniqueness
rule already sent it: the **Runs rail badge** (active + parked count) for "what's running right
now", and **Insights** for day totals. No surface re-prints another's numbers.

## Home — Chat + Overview (D-103, D-105)

`HomePage` renders a `Chat | Overview` `SegControl` (last choice remembered per device,
`localStorage k.home.view`; a fresh install lands on **Chat** so a first boot faces K, not an empty
grid). The Message Dock **bar** variant is mounted once at Shell level for this route and is the
composer for both sub-views.

### Chat (`ChatView`)

A thread-list rail (rename, archive, `+ New chat`) beside the selected thread's transcript. **K
threads are K's OWN conversational history only — deliberately not a second view onto agent run
execution** (D-103): a thread turn that triggered a dispatch carries a `runId` and renders a
**`→ view run`** chip into the real `RunConsole`; the structured tool-call/diff/timeline rendering
stays exclusively on Runs. Selection has an honest degrade path — a failed thread-list read never
hard-blocks the chat, and a selected id absent from a freshly-invalidated list demotes to the newest
remaining thread (never silently to a stale one).

### Overview (`OverviewView` — the widget grid, D-105)

A fixed **3×3 grid** of up to 9 catalog widgets. Placement (`HomeLayoutSchema` — in-bounds,
non-overlapping, no duplicate ids, `.strict()`) persists server-side via
**`GET`/`PUT /api/settings/home-layout`** (Zod `safeParse`, `400` on an invalid layout) through the
existing `config-store.ts`; `useHomeLayout` writes **optimistically** (instant customize-mode feel)
then fires the PUT, cancelling any in-flight GET first so a slow initial fetch can't stomp a fresh
edit. **Customize mode** (`overview-customize` toggle) reveals per-widget chrome (resize/move/
remove) and a `+` add-button on every free 1×1 cell, computed by the same `fits()` geometry the
server enforces — the client can never construct a layout the server would reject.

| Widget id | Title | Notes |
|-----------|-------|-------|
| `active_runs` | Active runs | |
| `needs_you` | Needs you | |
| `org_glance` | Org at a glance | |
| `recent_activity` | Recent activity | |
| `cost_today` | Cost today | |
| `personal_tasks` | Personal tasks | |
| `notes` | Notes | |
| `schedule` | Schedule | |
| `project_health` | Project health | |

The catalog is a **literal `Record<HomeWidgetId, WidgetDef>`** (`web/src/pages/home/widgets/
index.tsx`), not a keyed map — a future 10th widget id fails typecheck here instead of rendering a
blank cell. The **default layout** (used before the first save, and whenever the server answers
`{ layout: null }`) places 5 widgets to fully tile the grid: `active_runs` (2×1) + `needs_you` (1×1)
across the top row, `recent_activity` (2×2) filling the middle-left block, `cost_today` (1×1) and
`personal_tasks` (1×1) down the right column — `org_glance`, `notes`, `schedule`, and
`project_health` are available to add via the picker but not placed by default. Each cell's widget
**body** is wrapped in its own error boundary, independent of the customize-mode **chrome**, so one
throwing widget can never take the rest of the grid down and stays resizable/removable even while
broken.

## Personal hub (D-101, 4 tabs → 3 after D-123)

`PersonalPage` — one `Tabs` surface, mirrored by `AgentsPage`'s shape:

| Tab | Content |
|-----|---------|
| **Inbox** (default) | the needs-you queue — moved intact from the old standalone InboxPage; still the same **union over 5 sources**, read live, never a table (below) |
| **Tasks** | full work-item management — a **Personal/Org** `SegControl` over the durable `work_items` store (ported from K-home's old "Your work" card) plus read-only **Notes** and **Schedule** cards |
| **Memories** | the operator's own durable **user-memories** store (below) — add / inline-edit / confirm-gated delete, with a **"→ from chat"** link back to the source thread when K saved the memory itself |

The former **Chats** tab — the full thread-management surface — **folded into Messages (D-123)**:
rename / archive / unarchive / confirm-gated permanent delete (a thread with a live run still 409s
inline), the archived toggle, and search all live on the Messages page now, so no operator
capability was lost; `#/personal/chats` redirects there.

The rail badge is the shared inbox count (`inbox-query.ts`'s one `INBOX_KEY` query — the page, the
badge, and the Inbox tab's own count all key off it, zero extra fetches).

### User memories + `memory_save` (D-104)

A `user_memories` table (`UserMemory`: `content`, optional `sourceThreadId`) holds durable facts or
preferences **about the operator** — distinct from §04's agent-memory **lessons** queue, which is a
proposed-process-change with an accept/reject review gate. A `UserMemory` has **no review gate**:
the operator edits it directly on Personal → Memories, and **K's `memory_save` MCP tool**
(`core/src/mcp/logistics.ts`) writes to the same store from inside a conversation — "Remember a
durable fact or preference about your operator... Use for lasting facts, never transient task
state." Every save **quietly notifies**: a `notifications` row (`eventKey: 'memory_saved'`, title
"K remembered", body truncated to 140 chars) lands in the in-app center — never a modal, but never
silent either. `memory_save` and the resulting "your current memories are…" prompt injection are
wired into **K's secretary charter only** (`agent-config/tiers/secretary.charter.md`) — Chief and
the leads neither call the tool nor carry the injection, keeping "knows the operator" a property of
the one agent that actually talks to them.

## Messages — every conversation in one place (Continuous Agents, D-123)

`MessagesPage` (rail entry between K and Personal, chord `g m`, deep link `#/messages/<threadId>`)
is the unified conversation surface: a grouped list — **K's threads first**, then **one conversation
per durable agent** (managers + leads, auto-created idempotently on listing) — beside the selected
transcript, rendered by the shared **`ConversationView`** (extracted from `ChatView`, so Home →
Chat, agent detail pages, and Messages all render one component).

- **Unread badges** ride a per-thread `last_read_at` cursor (advanced on open, monotonic-clamped);
  the operator's **own delivered messages never badge** their target conversation.
- Each conversation header carries a **session-state chip** (live/resumable) and the **context
  meter** — real runtime state, rendered only when the caller supplies real data (Home fabricates
  neither).
- A **batched delivery** (an idle agent woken with several queued messages) renders as
  **per-segment sender bubbles** — the transcript splits the batch at its provenance boundaries so
  each sender (and an urgent chip) attributes correctly, never a first-sender-wins collapse.
- **Report-backs render as messages FROM that agent** — a lead's outcome is a bubble from the lead,
  a briefing a bubble from the manager, in the conversation where it landed (§04).
- **K-thread management folded in from Personal → Chats** (redirect above): rename,
  archive/unarchive, confirm-gated delete, the archived toggle, and search.
- **Agent detail pages embed their conversation** — an orchestrator's page shows the same
  transcript panel, so "talk to this agent" is one click from its detail view. The Dock is unchanged
  as the quick path to K (its route chip is a preview only, D-126).

## Agents hub (D-101 folded the surfaces in; D-120 restructured the tab shape)

`AgentsPage` merges Org + the capability catalog + the pipeline surface under one `Tabs` surface.
**The Orchestration Program Phase 2 IA restructure (D-120) renamed and reshaped the original D-101
`Org · Skills · Pipelines` split into three top tabs — `Org` / `Catalog` / `Automations`**
(`web/src/pages/AgentsPage.tsx` `TAB_IDS`); legacy `#/agents/skills/*` and `#/agents/pipelines/*`
deep links redirect straight into the new tabs (Retirements & redirects, below):

| Tab | Content |
|-----|---------|
| **Org** (default) | the roster of leads behind a **Roster / Tree / Graph / Domains** `SegControl` (`OrgPage`) — Roster is slim cards, Tree is the whole-org DelegationTree, Graph is the fleet 3D graph (P4's "one org surface", D-096), and **Domains** is the domain registry (D-125, below). Carries a **read-only autonomy status chip** (Autonomy OFF/ON) deep-linking to Settings → Autonomous Org — no duplicated controls (P5 Autonomy, D-107) |
| **Catalog** | the reusable building blocks — formerly the standalone "Skills" tab, now 4 routed sub-tabs: **Skills** (the capability catalog itself, default — below) · **MCP** · **Hooks** · **Sub Agents** (NEW, D-120 — the editable worker registry, below) |
| **Automations** | the unified pipeline surface (`AutomationsView`) — formerly the standalone "Pipelines" tab plus the Catalog-side workflow-skills registry, now 3 sub-tabs: **Library** (pipeline definitions, incl. the 6 seeded standard pipelines, below) · **Runs** (pipeline execution history + the live DAG) · **Schedules** (cron-triggered skills AND pipeline schedules — merges the old triggers/schedules/eval-history registry, below) |

**Domains (the 4th Org segment, D-125).** `DomainsView` lists the domain registry — each row with
its manager and description plus a per-row **Edit** dialog (name/description; manager reassignment
stays API-only behind the chief-tier guard) — a **create-with-manager dialog** (`POST /api/domains`
with a `manager` block spins up the domain and its chief-tier manager profile in one step), and a
**manager overlay editor** for the L1.5 `identity_overlay` (prefilled from the current value before
save; clearing it silences the seed).

### Orchestrator detail (drill-in, `#/orchestrator/:id`)

Reached from Org → Roster → **Open**, not a rail destination itself. Six tabs now: **Charter · 
Skills · Tools · MCP servers · Memory · Runs** (Task 17 added **Runs** — the lead's recent activations,
measured `RunStatus` + `cost_usd` resolved server-side — and gave **Memory** a
**Pending / Accepted / Rejected** `SegControl`, was accepted-only). The header carries a **per-lead
recent-cost line** sourced from `GET /api/metrics/recent-actuals` — **measured** median/p90 of
stored run costs, never price × token estimation — alongside the existing recent-health line and
`effectiveModel` chip. The **per-lead authority override panel** still reads "inherits the org
default unless overridden"; the org-default itself is edited only in Settings.

### Catalog — the capability catalog + worker registry (D-069..D-071, D-120)

`CatalogPage` (`Agents → Catalog`) is **one destination, four routed sub-tabs** — **Skills**
(source badge, model-compat badge, est-token chip, enable toggle, SKILL.md preview; the *default*
sub-tab and the direct successor of the old standalone "Catalog" sub-tab) · **MCP** (tier-template +
discovered-host servers behind the TrustDialog) · **Hooks** (read-only host-hook visibility) ·
**Sub Agents** (NEW, D-120 — below) — headed by the `CapabilityStatRow` totals strip. Skills/MCP/Hooks
content is unchanged from the host-integration program; only its address moved, first from a
standalone rail entry to `Agents → Skills` (D-101), then to `Agents → Catalog` (D-120). The old
4th "Automations" sub-tab (triggers/schedules/eval history) is **retired from Catalog** — its data
and affordances now live on `Agents → Automations → Schedules` (below); legacy
`#/agents/skills/automations` redirects there.

**Sub Agents — the editable worker registry (NEW, D-120).** Every profile an orchestrator's pipeline
stage can dispatch to, catalog-style: **K-native rows** (`source:'k'`, parsed live from
`agent-config/agents/*.md`) are **read-only** here — a **Fork to edit** action clones one into a new
**operator row** rather than mutating the shipped file — while **operator rows**
(`source:'operator'`, the `sub_agent_defs` table) carry full CRUD (edit/delete/enable) through
`GET/POST/PATCH/DELETE /api/sub-agents`. A pipeline `agent` stage names its actor via `subagentType`,
resolved against this registry at dispatch time. **Honest limitation (Phase 2.5, tracked):**
creating or editing an operator worker here does not yet make it *runnable* as a live pipeline stage
— the registry row exists and is fully editable, but the create-time materializer that mounts it as
a confined, dispatchable worker file is a later phase (§09 roadmap).

## Automations — the unified pipeline surface (D-120)

`AutomationsView` (`Agents → Automations`) folds the former standalone "Pipelines" tab and the old
Catalog-side workflow-skills registry into **one surface, three panes**:

- **Library** — pipeline **definitions**, including the **6 seeded standard pipelines** (Implementation
  Cycle, Deep Research, Bug Triage & Fix, Refactor, Security Audit, Quick Task) plus any custom
  `PipelineSpec`/`NamedWorkflow` defs; a definition's stage sequence, cross-project flag, and the
  **"Run this workflow"**-style pipeline launcher (`RunPipelineDialog`) all live here — the direct
  successor of the old standalone Pipelines tab.
- **Runs** — pipeline execution history and the **live DAG** (`PipelineGraph` — a React Flow
  pan/zoom/minimap canvas since D-121, per-stage cards, gate
  dialog), plus the **progress ledger** panel (`PipelineLedgerPanel`, D-120) and an **orchestrator
  multi-pipeline view** — runs grouped by owning orchestrator via `pipeline_runs.owner_profile_id`.
- **Schedules** — cron-triggered skills AND **pipeline schedules** in one list. **Routines were made
  first-class here in P5 Autonomy (E-16, D-110)**: an **NL→cron helper** (RULES-ONLY, no model — an
  unmappable phrase returns `400` at the route boundary, never a guess), a **next-run** display, and a
  **measured cost per routine** (summed from its run history via a JOIN to `runs.cost_usd` — measured
  actuals, never estimated). **D-120 extends the same routine with an optional pipeline target**
  (`skills.pipeline_def_id` → `RoutineView.pipelineDefId`) — a routine can now trigger a pipeline
  manually or on its cron schedule, not just a skill.

## Runs (rail entry, now a plain master-detail)

**Runs no longer carries a Workflows sub-tab** — that content moved to Agents → Automations → Library/Runs
(above), so `RunsPage` is now exactly a `RunList` + `RunConsole` split with nothing else. Runs render as
**structured, collapsed-by-default** items — commands (`$ …` with output on expand), file ops (Write
preview, Edit/MultiEdit diff hunks), and delegated sub-agents (type + label, full prompt + result on
expand). A **Console / Timeline / Changes** `SegControl` toggles the console between the dense event
stream, the replayable per-seq **Timeline**, and the **Changes** review surface (below). Interactive
runs show an **answer box** (ask → answer → continue) with **End session** and **Compact context**,
plus a **`ctx X / Y · Z%`** pressure meter. (Internals in §13.)

### Changes — the review surface + full-screen PR review (D-118)

The **Changes** tab (`components/ReviewDeck.tsx` → `ChangesLayout.tsx` + `DiffViewer.tsx` v2) is a
first-class in-run diff review: a left file list (per-file `+`/`-` stat, a persisted **viewed ✓** per
path via `getViewed(identity)`) beside the right `DiffViewer` pane, which renders `refractor`-tokenized
code inside the `.code-viewer` scope colored entirely by the `--code-*` tokens above. The deck header
carries a files·+/− chip, a `truncated` badge, the `VerifyChip`, and two actions — **Request changes**
(bundles draft comments into a fix run) and **Approve → PR** (publishes the run's final checkpoint as
a `k-review/*` branch and opens a PR). For checkpoint runs an **Expand context** affordance bumps the
diff context 3→24 lines on first use (PRs never expand). A `changes-badge` (`N files +A −B`) rides the
console header, fed by one cheap default-context diff query that dedupes with the deck's own.

**Full-screen PR review** lives at the `pr-review` route (`#/pr-review/<projectId>/<n>`,
`pages/PrReviewPage.tsx`, registered in `route.ts`'s `KNOWN_VIEWS`) — the **same** `ChangesLayout`
tree+diff, mounted with **`readOnly`** so comment add/delete and file-expand are disabled and nothing
is ever posted back to GitHub (K has no GitHub-comment-write plumbing; the read-only boundary is
honest, not a stub). `PrsCiTab` opens it via an **Open review** action on each PR row.

## Insights (4 tabs, unchanged)

**Overview** (deterministic deltas + z-score anomalies, measured-only, no LLM) · **Charts**
(tokens/cost/run trends, KPI tiles, cost-by-lead, error-rate, latency p50/p95, success+latency day
trends, plus **P5 Autonomy's budget burn-down — measured 24h, zero-forecast — and retry-rate**
charts, §13) · **Routing** (model-routing outcomes — cost/latency/success by provider+model) · **Evals**
(the behavioral eval subsystem, §07). A shared 14/30/60-day window `SegControl` covers
Overview/Charts/Routing; Evals runs its own independent view. Content and internals are unchanged
from P4 — only the address moved from 3 standalone rail entries (Metrics/Routing/Evals) to 3 of
Insights' 4 tabs.

## Projects — workspace, 7 tabs (unchanged)

A project opens into its workspace, unchanged in shape:

| Tab | Content |
|-----|---------|
| **Overview** | health score breakdown, latest verification summary, recent runs, open PRs, bible freshness, quick actions |
| **Knowledge Graph** | per-project 3D graph, first-class (below) |
| **Runs** | this project's runs: live consoles, history, replay from the event log |
| **Tasks** | project tickets (`work_items`, scope `project` — §04), optional GitHub Issues sync, multi-select → run a delegation workflow |
| **PRs & CI** | open PRs with check status, diff links, Actions run history |
| **Verification** | report timeline, findings by severity, fixes applied, re-run button |
| **Artifacts** | this project's OWN artifacts as a gallery (only `project-<id>-*`, not the harness globals), each in a sandboxed iframe; a regular artifact edits as markdown, a **bible edits per SECTION** with source-of-truth writeback + recompile |

## Data model & API additions (schema v10 → v11)

- **Multi-thread K** — `k_threads` (id, title, `archived`, timestamps) + `k_thread_turns` (role,
  text, optional `runId`), `KThreadSummary`/`KThreadDetail` types. `GET/POST /api/threads`,
  `GET /api/threads/:id`, `PATCH /api/threads/:id` (title/archived), turns append on ask/reply.
  `useAskK` accepts a `threadId` so the same send path drives both K-home Chat and Personal → Chats.
- **User memories** — `user_memories` table + `UserMemory` type (`content`, `sourceThreadId?`,
  timestamps). `GET/POST/PATCH/DELETE /api/memories`; `memory_save` (MCP, secretary-only, above)
  writes through the same route the UI uses.
- **Home layout** — `HomeWidgetIdSchema` (9-member `z.enum`), `HomeWidgetPlacementSchema`
  (`x`/`y` 0-2, `w`/`h` ∈ {1,2}, `.strict()`), `HomeLayoutSchema` (≤9 widgets, `superRefine` rejects
  out-of-bounds/overlap/duplicate ids). `GET/PUT /api/settings/home-layout`
  (`core/src/routes/home-layout.ts`) persists via `config-store.ts`'s `homeLayout()`/
  `setHomeLayout()` — `400` on a `safeParse` failure, never a silent partial write.

All three are additive to schema v10 (P4) — no destructive migration, no `WsMessage` shape change.

## Retirements & redirects (D-106; extended by D-120, D-123)

Every view string either restructure removed from `KNOWN_VIEWS` keeps a `VIEW_REDIRECTS` entry
(`web/src/lib/route.ts`) so a bookmarked or shared legacy hash still resolves — applied via
`history.replaceState` (never a push), so Back never bounces through a dead intermediate hash. **D-120
added the `agents/skills/*` → `agents/catalog/*` and `agents/pipelines/*` → `agents/automations/*`
entries below** (operating on Agents' own sub-param, mirroring the pre-existing `runs` entry, so an
already-canonical `#/agents/<catalog|automations|org>/*` hash passes through unchanged):

| Legacy hash | Redirects to |
|-------------|---------------|
| `#/chief` | Agents → Org → Tree |
| `#/orchestrators` | Agents → Org → Roster |
| `#/graph` | Agents → Org → Graph |
| `#/metrics` | Insights → Charts |
| `#/routing` | Insights → Routing |
| `#/evals` | Insights → Evals |
| `#/workflows[/:id]` | Agents → Automations[/:id] |
| `#/workflow-detail/:id` | Agents → Automations/:id |
| `#/memory` , `#/lessons` | Personal → Inbox |
| `#/terminal` | Settings |
| `#/org[/:seg]` (P4-era) | Agents → Org[/:seg] |
| `#/skills[/:tab]` (P4-era) | Agents → Catalog[/:tab] *(D-120; a bare `#/skills/automations` — the retired workflow-skills registry sub-tab — redirects to the top-level Automations tab instead of a nonexistent Catalog sub-tab)* |
| `#/agents/skills[/:tab]` (D-101-era) | Agents → Catalog[/:tab] *(D-120)* |
| `#/agents/pipelines[/:id]` (D-101-era) | Agents → Automations[/:id] *(D-120)* |
| `#/inbox` (P4-era) | Personal → Inbox |
| `#/personal/chats` | Messages *(D-123 — the Chats tab folded into the Messages surface; other `#/personal/*` tabs pass through unchanged)* |
| `#/runs/workflows[/:id]` | Agents → Automations[/:id] — plain `#/runs/:runId` is unaffected (identity redirect, `resolveRoute` never re-navigates a real run id) |

An unrouted hash that matches none of the above (and isn't a canonical view) is still a 404
(`Shell`'s default `NotFound` branch) — the redirect table only covers views that genuinely moved.

## Visibility (P3, unaffected by this restructure)

Phase 3 makes the org's *history* legible without adding a write path — every surface below is a
**derivation** over data the harness already stores.

### Run Narrative card (E-08, D-086)

Every run gets a **Run Narrative** card in the run console. Its **deterministic fields** — goal,
outcome, files touched, verification, cost — are derived from the run's own events and **always
render**. Below them, physically separated, sit **at most three Decisions and three Risks bullets**
from the local model, auto-attempted on open and **labeled "generated"**. If the local model is
unreachable or its output won't parse, the bullets **gracefully omit**; a bounded 20 s abort
guarantees the card's GET never blocks on a stuck stream.

### Org Timeline (E-09, D-085)

A single **Org Timeline** — one feed, git-log-style iconographic rows — is the org's activity
history, reached from Agents → Org (Tree/Roster context) or the hidden `timeline` route. **Kind
filter chips carry counts**. An opt-in digest inlines the Run Narrative card per event (capped at
12). Home's Overview `recent_activity` widget reads the same feed, so the widget and the Timeline
view cannot disagree. The Runs rail badge (the old ActivityStrip's role) is deliberately **not**
re-pointed at this capped feed — it stays a live, uncapped count.

### Relative weight bands (E-13, D-087)

The capability-catalog token chips are relative light/medium/heavy weight bands — a context-cost
hint, **never a dollar figure**. Measured cost roll-ups live on Insights and in §13.

### Single HealthRubric (E-12, D-088)

One canonical `healthRubric` (≥75 healthy / ≥50 warn / else critical / null unknown) is consumed by
every web health surface (ProjectCard, FleetGraph, ProjectVerification, ProjectWorkspace, verify).

### Glossary tooltips (E-12, D-088)

Terms defined in §14 render an inline `GlossaryTerm` tooltip wherever they appear, extracted at
`pnpm bible` compile time into a committed generated module (`web/src/generated/glossary.ts`).

## Notifications + the Personal Inbox

- **The Inbox tab (Personal) is THE "needs-YOU" surface.** A **UNION over six sources** — plan
  approvals (runs parked at `awaiting_plan`), `awaiting_input` parks, pending lessons (§04),
  untrusted MCP servers, review-ready runs, and **autonomy proposals (P5 Autonomy)**. It is **a
  query, never a table** (D-081): each item is read live from its own authoritative source, so it can
  never drift out of sync.
- **Proposal cards (P5 Autonomy, E-14/E-18).** The `proposal` inbox kind surfaces the **blocked**,
  sourced `org` work_items the collectors + self-heal write (§07): a card shows its `source` chip
  (ci_failed / verify_finding / open_issue / stale_bible; a self-heal park renders under the
  **verify** chip) and two inline actions — **Approve** (→ `open`, enters the backlog for E-15
  auto-pull, §04) and **Dismiss** (→ `cancelled`, **sticky** — the collector won't re-nag; **no undo**
  on dismiss, a documented default-OFF limitation, D-111). The `InboxCounts.proposal` count feeds the
  same needs-you badge.
- **Dismissal semantics.** A review-ready run dismisses via a stamp-once `runs.reviewed_at`. An
  untrusted-MCP card dismisses via an `inbox_dismissed_hash` pinned to the server's `config_hash` —
  a later config drift re-surfaces the card. A **proposal** dismisses by flipping its work_item to
  `cancelled` (the `source_key` still resolves it, so it stays dismissed).
- **Notification rules and channels.** A seeded `notification_rules` table maps event key → channel
  (in-app and/or browser). The in-app center is durable; the browser leg is transient (dedupes on
  status transitions, fires only when the tab is hidden AND permission is granted, gesture-requested).
  `memory_saved` (D-104) is one such event key, seeded `inapp: true` by default.

## Settings + Help

- **Settings** — provider/auth status cards (no secrets), the guarded global CLAUDE.md editor, and
  the **org-default authority / MCP panel** — per-lead overrides live on orchestrator detail
  ("inherits org default unless overridden"); Settings owns the default, detail owns the delta.
- **Autonomous Org (P5 Autonomy, `SettingsAutonomy.tsx`, D-107).** The single front door for the whole
  autonomy stack (§03): a master **enabled** toggle (**default OFF**) + sub-toggles (Generate proposals ·
  Auto-pull backlog · Self-heal failed runs) + **max-concurrency** + **org daily budget cap** + **warn %**,
  persisted as one `app_config` blob (`autonomy.settings`). Toggling ON applies at runtime, no restart.
  The master gates all four autonomous behaviors; the **budget governor is the always-on safety cap**
  (applies even when autonomy is OFF once set — D-108). Agents → Org mirrors only a read-only status chip.
- **Claude default model** — a Settings picker sets the global Claude default model
  (`app_config`-managed, applies to the next run, no restart). The Dock's `KAskBody.model` override
  still overrides it for a single dispatch.
- **Local models (Ollama)** — installed models with an active badge + selector (live, no restart),
  per-model Remove, a curated catalog with a "fits on disk?" badge and Pull with a live progress bar.
- **Voice transcription** — a reusable push-to-talk `MicButton` wired into the Message Dock composer
  and the run-console HITL reply box: hold to record → `POST /api/transcribe` (core proxies to a
  local Whisper server; the browser holds no key) → the transcript lands as ordinary text for review
  before send. Audio is transcribed locally and never leaves the box.
- **Help** — opens the **in-app multi-page guide** (D-116, `web/src/help/HelpGuide.tsx`), not this
  bible. A ~880px Radix Dialog with a left page rail + article body, `ArrowLeft`/`ArrowRight` and
  Prev/Next navigation over **7 bundled pages** (`HELP_PAGES`): Welcome to K · Messaging K &
  dispatching · Runs & reviewing changes · Projects, bibles & artifacts · Agents & the org · Insights
  & budget · Settings & shortcuts. Content ships with the web app (no backend, no bible deep-link);
  Docs/bible remain reachable in-app via edit-in-place per section, just not from the Help entry.

## Universal interaction patterns

- **Compose-is-confirm + undo.** A K-routed dispatch sends straight from the Dock composer with the
  route shown inline and a **5 s undo** toast — no confirm step for the common case. The full
  confirm-card (target · model · scope) appears only for an explicit `@project` target or another
  escalation (T3 authority, destructive kill/delete/reassign).
- **Toast-with-link is universal.** Every action drops a toast with a direct link to what it
  created — no result has to be hunted for.
- **Metric uniqueness.** Every metric is printed in exactly one place — live counts on rail badges,
  day totals and trends in Insights, health on Org's thin line / project Overview.
- Live state streams over the existing WebSocket; the UI never blocks on a poll. `run_update` WS
  events invalidate the Agents/Org queries too, throttled leading+trailing at 250 ms
  (`lib/live-invalidate.ts`).
- **Breadcrumbs.** `TopBar` renders real breadcrumbs for the param-routed detail views —
  *Agents › Org › \<name\>*, *Agents › Automations › \<name\>*, *Projects › \<name\>*. **D-120 dropped
  the leading tab icon from `TopBar`'s title** (`topbar-title` is title/breadcrumb text only now — the
  `Icon`/`IconName` lookup it used was deleted, not merely hidden).
- **Focus + a11y.** The Message Dock overlay carries `role="dialog"`/`aria-modal`/label and a focus
  trap (`lib/useFocusTrap.ts`) that returns focus to the FAB on Escape; ConfirmDialog and the evals
  RunDialog get the same trap. Accent fills always use dark `--bg` text via the `--on-accent` token.

## Knowledge graph spec (fleet + per-project, unchanged)

The **Graph is the structural code/fleet graph** — modules · files · symbols · dependencies — not a
second delegation view; delegation (who is working for whom) is owned by the one `DelegationTree`
component (Agents → Org → Tree at whole-org scope, orchestrator detail at one-lead scope).

- **Renderer:** `react-force-graph-3d` (Three.js/WebGL) with a collision force; each surface is
  wrapped in an error boundary. **Always import the renderer subpackage** (`-3d`/`-2d`), never the
  `react-force-graph` aggregate — it references a non-existent global `AFRAME` and throws at
  module-eval time, blanking every route (guarded by a static import test).
- **Data source:** GitNexus indexes per project; fleet edges from manifest/dependency scanning.
- **Level of detail:** modules → files → symbols, plus a *hot paths* overlay. Double-click expands a
  node one level; breadcrumb chips track depth.
- **Node inspector:** live facts — file/symbol counts, failing tests, last-touched-by, bible links —
  and dispatch actions ("fix failing tests here", "explain this subsystem").
- **Interactions:** scroll = zoom, drag = pan, `f` = fit, search dims non-matches in place.
- Health/status colors the graph — failing modules glow red, untested amber, healthy blush.

## Design tokens (vivid midnight-glass — UI Polish, D-114)

Values remain the single source in `web/src/index.css` `:root`, mirrored into
`web/tailwind.config.ts` (Tailwind's semantic `colors`/`borderRadius`/`fontSize`/`fontFamily`
extensions) and `core/src/ui-artifact.ts` (the `ui-demo` inline CSS) — change all three together
(D-024's rule, unchanged by this program).

**Palette** (unchanged): `bg` `#1b1030` / `surface` `#2a1a47` / `raised` `#33205c`; hairline border
`#3a2a5c` / strong border `#4a3775`; `text` `#f4f0ff` / `muted` `#b3a6cd`; accent — **blush**
`#ff8fc0` (fills/active pills/badges) — accent-hover — **sky** `#38bdf8` (hover/active/focus);
`--on-accent` `#241640` (dark text on accent fills, WCAG AA — white-on-blush fails); status
green/amber/red `#34d399`/`#fbbf24`/`#f87171`. The `--chart-1..8` + `--chart-other` dataviz palette
is the same family with exactly ONE token changed this program: **`--chart-8`** `#818cf8` →
**`#6366f1`** — a CVD validator run against the real dark surface (`#2a1a47`) found the adjacent
chart-7↔chart-8 pair failing protanopia contrast (ΔE 1.1); the same-hue snap to `#6366f1` passes
(ΔE 15.4). The validator's lightness-band check still fails all 8 chart tokens against a generic
dark-surface heuristic — accepted as non-actionable: the palette is brand-locked, contrast ≥3:1
still holds, and the dataviz mitigations (legend for ≥2-series charts, selective direct labels,
text-token colors for text) carry the rest.

**Glass tiers** (`@layer components`, `web/src/index.css`) — FOUR explicit tiers, picked by role,
not a single hero/non-hero switch:

| Class | Background | Blur | Radius | Used for |
|-------|-----------|------|--------|----------|
| `.glass-chrome` | `--glass-chrome-bg` rgba(24,24,34,.42) | `blur(24px) saturate(1.6)` | (caller's) | persistent shell chrome — Sidebar, TopBar, the Message Dock bar |
| `.glass-panel` | `--glass-panel-bg` rgba(28,28,38,.42) | `blur(22px) saturate(1.6)` | 18px | in-flow cards/panels — widget cells, KPI tiles, summary cards |
| `.glass-overlay` | `--glass-overlay-bg` rgba(30,30,42,.58) | `blur(28px) saturate(1.6)` | 18px | floating/portal surfaces — Dialog, Tooltip, popovers, the Message Dock float overlay |
| `.surface-solid` | `--surface` (opaque) | none | 14px | dense repeated rows — fleet/roster grids, list rows |

The tier fills have been re-graded twice. **Liquid Glass 2.0 (D-115, below)** first dropped them one step from the D-114 launch values (`.55/.72/.82` → `.48/.64/.76`) so body text held ≥4.5:1 AA/WCAG contrast against the brighter living-ambient layer. **UI Refinement (D-128, 2026-07-17)** then retuned the whole glass system from the D-011 purple family to a **neutral modern frosting** — the values in the table above (dark-neutral `.42/.42/.58`) over higher blur/saturate (22–28px / 1.6), with D-115's living-ambient *animation* and SVG *refraction* removed and the static wallpaper (below) supplying the backdrop. Only token **values** moved; the token **names** stayed stable, so `tokens.test.ts` and every consumer are untouched.

Each blurred tier carries an `@supports not (backdrop-filter: blur(1px))` opaque fallback
(`.glass-chrome`→`--surface`, `.glass-panel`/`.glass-overlay`→`--raised`) so a browser without
backdrop-filter support never renders transparent text-on-text.

**Rules — supersedes D-013/D-024's hero-only-glass binary.** The old rule ("glass is reserved for
hero surfaces… dense data views stay opaque") couldn't express *which* surface counts as hero or
what happens when two glass surfaces would nest. The shipped rule is graded: **(1)** pick the tier
by role (table above), not a single hero/non-hero split; **(2) no nested backdrop-filter, ever** —
a glass element that is a DOM descendant of another glass element drops to `surface-solid` or a
hand-rolled substitute (verified component-by-component during the build — e.g. TopBar's dock-
launcher button and NotificationBell's popover stay `surface-solid` because both are DOM children
of TopBar's own `glass-chrome` `<header>`); **(3)** a soft **≤6 simultaneously-blurred-regions-per-
viewport budget**, checked by a per-wave visual pass at 1440×900 and a final whole-app sweep — a
manual review discipline, not an automated test — that pushes a view over budget (an 11-tile KPI
row, a large fleet/roster grid) onto `tier="solid"` instead; **(4)** dense data still defaults to
opaque, unchanged from D-013/D-024.

**Blur-budget accounting.** Each glass tier is exactly **one** blurred region. (D-115's Liquid
Glass 2.0 added a refraction `::after` to `.glass-chrome`/`.glass-overlay` that counted as part of
its host's single region, not a second; **D-128 removed the refraction layer entirely**, so today
every tier is a single, un-nested `backdrop-filter` with no `::after` blur left to account for.)

**Accepted exception — Home → Overview (the default landing).** The final whole-app sweep
(1440×900) found every reskinned route at ≤6 blurred regions *except* Home's Overview, which
lands at **8**: the three always-present chrome bars (Sidebar, TopBar, Message-Dock bar, all
`glass-chrome`) plus the default 3×3 grid's five `glass-panel` widget cells. The `>5-widgets →
solid` flip (`OverviewView.tsx`) only trims the *sixth* widget onward, so the shipped 5-widget
default sits two regions over the soft ceiling. This is an **accepted, documented exception**, not
an oversight: the INT.5 performance trace (10s, 93 pointer moves over a `glass-interactive`
surface) measured a **`LayoutCount` delta of 0** and negligible recalc/paint at eight regions, so
the budget's underlying goal — no compositor thrash — holds; and the landing view is exactly where
the "glass where it matters" richness is most wanted. The ≤6 figure remains the design *target*
for new surfaces; Home Overview is the one sanctioned over-budget view, revisited if a future
device profile shows real cost. No other surface may adopt this exception without the same
measured-perf justification.

### Liquid Glass 2.0 — living ambient · refraction · specular edges · pointer sheen (D-115)

A second glass pass layers four effects onto the tier system above, each token-driven and
motion/capability-guarded. All new tokens live in `index.css` `:root` under the `LG2 (W0.2)` block.

> **Partly superseded by D-128 (UI Refinement, 2026-07-17).** The living-ambient blob **animation**
> (W0.3) and the SVG **refraction** (W0.4) described below were REMOVED; the `--lg-blob-*` tokens
> survive to paint the static wallpaper gradient presets (see the background system below), and the
> **specular edges (W0.5) are retained** (all three tiers still carry the `border-box` `--lg-edge`
> wash + `inset` highlight). The pointer sheen (W0.6) had already been replaced by D-121's static
> hover. The glass palette was retuned from the D-011 purple family to neutral modern-frosted (the
> tier table above holds the current values). The four bullets below document the LG2-era mechanics
> for the record.

- **Living ambient (W0.3, `shell/Ambient.tsx`).** The old three static radial washes are replaced by
  **four hue-drifting blobs** (`.ambient-blob-1..4`, one decorative `.ambient` layer, still the
  single decorative element) over a base `--bg-deep` + fractal-noise wash. Each blob is a
  `radial-gradient` of a low-alpha `--lg-blob-1..4` (violet / blush / sky / indigo, the D-011 family)
  animated by `@keyframes lg-drift-1..4` — **GPU-composited `translate3d`/`scale` only**, 66–114 s
  alternating cycles. `prefers-reduced-motion` zeroes `.ambient`/`.ambient-blob` animation.
- **Refraction (W0.4, Chromium-first, `@supports`-guarded).** `components/GlassFilterDefs.tsx`
  (mounted once in `Shell`) renders one hidden `<svg>` holding the `#lg-refract` filter
  (`feTurbulence` fractalNoise + `feDisplacementMap`, `scale = LG_REFRACT_SCALE = 14`, mirrored by
  the `--lg-refract-scale` token because SVG filter-primitive attributes can't read a CSS custom
  property). `.glass-chrome`/`.glass-overlay` gain a `::after` carrying
  `backdrop-filter: url(#lg-refract) blur(...) saturate(...)`, wrapped in
  `@supports (backdrop-filter: url(#lg-refract))` so non-Chromium engines fall back to a plain no-op
  ring. The `::after` sits at `z-index:-1` under `isolation:isolate` (host text stays out of the
  refracted backdrop) and is masked to the **outer ring** (`radial-gradient(... transparent 58%, #000
  96%)`) so text-bearing centers stay calm. `.glass-panel` deliberately has **no** refraction
  `::after` (the mid tier stays flat). Per the blur-budget accounting above, a tier + its own
  `::after` is **one** region.
- **Specular edges (W0.5).** Each tier's flat single-color fill is replaced by a **double
  background** — the fill on `padding-box` plus a `135deg` `var(--lg-edge)`→`var(--glass-tier-border)`
  wash on `border-box` — and an `inset 0 1px 0 var(--lg-edge)` box-shadow highlight. This supersedes
  the old `--glass-sheen` highlight everywhere; **`--glass-sheen` is now vestigial** (still defined in
  `:root`, referenced by no active rule).
- **Pointer sheen (W0.6, opt-in `.glass-interactive`).** *Superseded by D-121 (Phase 2.6) — see below.*
  Originally: `lib/use-glass-pointer.ts` mounted **one** window-level, rAF-throttled `pointermove`
  listener in `Shell` writing `--lg-mx`/`--lg-my` (viewport px) onto `<html>`, and
  `.glass-interactive::before` painted a 10%-alpha `--lg-sheen` radial highlight at those coords via
  `background-attachment: fixed`. Phase 2.6 replaced the cursor-tracking effect with a static hover
  (below); the hook + `--lg-mx`/`--lg-my` are gone, and `--lg-sheen` is retained (reused by the
  static gradient).

### Usability & Access (Phase 2.6) — page backgrounds · static hover · React Flow canvas · Access console (D-121)

- **Page background → user-settable wallpaper (`shell/Background.tsx`, D-128).** *Supersedes the
  D-121 galaxy/starfield variant system.* One route-agnostic `<Background>` mounted at Shell **z-0**
  paints the operator's saved wallpaper — a **solid** `--bg-deep`, one of four **static CSS gradient
  presets** (`aurora/dusk/ocean/ember`, recombining the retained `--lg-blob-*` tokens), or an
  **uploaded image**. Settings are JSON in `app_config` key `ui.background` (`BackgroundSettings
  {kind, preset, imageVersion}`, `GET/PUT /api/settings/background`; legacy `galaxy/blobs/aurora`
  values migrate in-read); the image is a file at `<DATA_DIR>/wallpapers/wallpaper.<ext>` (`PUT/GET
  /api/settings/background/image`, validated `png|jpeg|webp` ≤8 MB, fixed basename, route-scoped
  `bodyLimit`). Because every `/api/*` route is Bearer-gated a raw `<img>`/CSS `url()` can't attach
  the header, so the image loads via an **authenticated Blob fetch → `URL.createObjectURL`**
  (`lib/useBackgroundImageUrl.ts`, revoked on change/unmount) — no token in any URL, no route
  auth-exemption. **No canvas, no `requestAnimationFrame`:** the animated galaxy starfield
  (`lib/starfield.ts`) and the `<Ambient/>` blob layer are RETIRED. The root keeps the uniform
  `data-testid="app-background"` + `data-variant` contract and is `aria-hidden` (decorative). A
  **Settings → Appearance** picker (solid/gradient/image select + FileReader→dataURL upload + live
  preview) writes the preference and invalidates the `['background']` query.
- **Static glass hover (replaces W0.6 pointer sheen).** `.glass-interactive::before` now paints a
  static `linear-gradient(135deg, var(--lg-sheen), transparent 60%)` that fades in on `:hover` (plus a
  `filter: brightness(1.04)` lift) — no cursor tracking, no window listener. `--lg-sheen` is retained;
  `--lg-mx`/`--lg-my` and `lib/use-glass-pointer.ts` are removed.
- **Home chat glass.** The Home → Chat rail + transcript move `surface-solid` → `glass-panel`
  (`data-testid` `chat-thread-rail` / `chat-transcript`); the composer input container stays solid (the
  no-nested-`backdrop-filter` rule). This brings the Chat view to **5** blurred regions (3 chrome bars +
  rail + transcript) — within the ≤6 budget (distinct from Home → Overview's accepted 8-region
  exception above).
- **Pipeline graph → React Flow (`components/PipelineGraph.tsx`).** The hand-laid columnar SVG DAG is
  rewritten on `@xyflow/react` v12 + `@dagrejs/dagre` (a pure sync `layoutPipeline` in
  `lib/pipeline-layout.ts`, `rankdir:'LR'`) as an **interactive read-only viewer**: pan / zoom / minimap
  / controls and ephemeral drag-to-reposition (NOT persisted — the definition stays canonical). It
  consumes the same `PipelineRunView` and live `['pipeline-run', runId]` cache (no new WS plumbing), so
  status still updates live; custom `PipelineStageNode`s are keyboard-activable (`role=button`,
  Enter/Space → select), and pass-edge marching-ants animation is frozen under `prefers-reduced-motion`.
  **D-128** additions: the same graph now also renders inside the pipeline **definition** inspector
  (`PipelineDefInspector`, via `lib/pipeline-preview.ts` `previewViewFromSpec` — synthesized `pending`
  stages, attempt line hidden at `attempt:0`), so analyzing a definition shows a DAG, not just text;
  and the library-default white React Flow MiniMap/Controls are themed to the dark app via
  `colorMode="dark"`.
- **Unified Access console (`pages/AccessPage.tsx`, the 4th Agents-hub tab).** A who-has-what matrix —
  orchestrator leads + sub-agent workers (K-native read-only + operator editable) × model / tools /
  skills / MCP — with expandable
  inline editing (the editable default-model `<Select>` + catalog-backed `CapabilityPicker`s, patched
  through the same validated `api.orchestrators.update` / `api.subAgents.update` endpoints; K-native
  workers render read-only) and a prominent **Auto-index** (capability rescan) button. Sub-agent workers
  now also have a real **default-model Select** on their editor and are **ceiling-validated** at the
  orchestrator tier on create/update (D-121 — the server, not the console, is the authorization
  boundary). Available models are the unified Claude ∪ installed-Ollama list (`GET /api/models/available`).

**Shadow ramp:** `--shadow-1` `0 2px 8px rgba(10,4,24,.35)` · `--shadow-2` `0 6px 24px
rgba(10,4,24,.45)` · `--shadow-3` `0 16px 48px rgba(10,4,24,.60)` — chrome/panel/overlay use
1/2/3 respectively (deeper tier, deeper shadow).

**Motion tokens:** `--dur-1` 120ms · `--dur-2` 180ms · `--dur-3` 240ms · `--ease`
`cubic-bezier(0.2,0,0,1)` — button/input transitions run on `--dur-1`; the skeleton shimmer sweep
(below) is a separate 1.6s cycle; `prefers-reduced-motion` zeroes the ambient drift, live-glow
pulse, and shimmer animations.

**Type scale** (`web/tailwind.config.ts` `fontSize` extension, not in `index.css`): `display`
24px/32px/600 · `title` 16px/24px/600 · `body` 14px/22px · `label` 12px/16px/500 · `caption`
11px/14px · `micro` 10px/12px (the `.micro-label` CSS class layers on uppercase + 0.08em tracking +
`--muted` for kicker/section-header text). `Inter Variable` (self-hosted
`@fontsource-variable/inter`) for UI text, `JetBrains Mono` (self-hosted
`@fontsource/jetbrains-mono`) for numerals/ids/code; `body { font-variant-numeric: tabular-nums; }`
is global, plus an explicit `.mono` utility for monospace runs — every number is mono so columns of
metrics align.

**Radii:** `--radius-lg` 18px (panels) · `--radius` 14px (controls), mirrored as Tailwind
`rounded-panel`/`rounded-control`; `--radius-sm` 10px (small surfaces — e.g. the skeleton shimmer,
`index.css`'s `.shimmer` rule) is consumed directly via `border-radius: var(--radius-sm)`, with no
Tailwind utility mirror. `rounded-pill` is a separate, unrelated Tailwind radius (`9999px`, fully
round) for badges/dots/tags — not tied to the 10px small-radius value.

**Code-viewer syntax theme (`--code-*`, DiffViewer v2 — D-118).** Eleven `--code-*` custom
properties (`--code-keyword`/`-type`/`-function`/`-string`/`-comment`/`-number`/`-operator`/
`-punctuation`/`-property`/`-tag`/`-attr`) in `:root` define the diff/code syntax palette, derived
from the D-011 family (e.g. `--code-keyword` violet, `--code-string` green, `--code-comment` a
4.96:1-on-`--surface` muted violet). A `.code-viewer` scope in `index.css` maps `refractor`/Prism
`token <type>` class names onto these tokens, so **no third-party syntax-highlighter CSS is ever
imported** and the ui-token gate stays at zero. Line/word add-remove highlights carry **no** dedicated
tokens — the FE lane reuses `--green`/`--red` via Tailwind.

**Runtime token access outside the DOM:** `web/src/lib/tokens.ts` exports a hand-kept
`TOKEN_FALLBACKS` hex mirror of `index.css`'s `:root` plus `readToken(name)` (reads
`getComputedStyle` when `window` exists, else the mirror) — used by the canvas-rendered
graph/health surfaces and by jsdom tests, neither of which can resolve a live CSS custom property.
`lib/tokens.ts` and `index.css` are the only two files exempt from the ui-token gate (below).

## `web/src/ui/` primitive kit + Tabs/SegControl

`web/src/ui/` is **14 files exporting 19 named primitives**, hand-authored on
`@radix-ui/react-dialog` + `@radix-ui/react-tooltip` (unstyled behavior primitives) and Tailwind —
not a shadcn/ui copy-paste base:

| File | Exports | Notes |
|------|---------|-------|
| `Button.tsx` | `Button`, `IconButton` | 4 variants (primary/glass/ghost/danger) × 2 sizes (sm/md); `loading` swaps in `Spinner`; `IconButton` is a square `Button` wrapping one `Icon` with a required `label` |
| `Dialog.tsx` | `Dialog` | Radix root/portal/overlay/content, `glass-overlay` tier, built-in title + close + footer slots |
| `EmptyState.tsx` | `EmptyState` | icon bubble (its own `.glass-panel`) + headline + optional hint/action |
| `ErrorState.tsx` | `ErrorState` | `role="alert"`, message + optional Retry `Button` |
| `Field.tsx` | `Input`, `Textarea`, `Select` | one shared skin string + an `invalid` boolean → red border + `aria-invalid` |
| `GlassPanel.tsx` | `GlassPanel` | polymorphic (`as`), `tier` ∈ chrome/panel/overlay/solid, `interactive` adds `.card-lift` hover |
| `Icon.tsx` | `Icon`, `ICONS`, `IconName` | 33-entry `lucide-react` map (below) |
| `KpiTile.tsx` | `KpiTile` | label/value/optional `delta` (`{pct, polarity}` — `goodUp`/`badUp` decides green vs red independent of the raw sign); `tier` ∈ panel/solid |
| `SectionHeader.tsx` | `SectionHeader` | `.micro-label` kicker + optional count pill + right-aligned action slot; `as` ∈ `h2`/`h3`/`span` (default `span`) |
| `Skeleton.tsx` | `Skeleton`, `SkeletonRow`, `SkeletonTile` | shimmer primitives (below) |
| `Spinner.tsx` | `Spinner` | inline SVG ring, `role="status"` |
| `StatusPill.tsx` | `StatusPill` | dot + label (below) |
| `Tag.tsx` | `Tag` | 3 tints (neutral/accent/sky) + optional dismiss button |
| `Tooltip.tsx` | `Tooltip` | Radix root, `glass-overlay` content, 300ms delay |

**`Icon`'s 33-icon set** is the ONLY file in `web/src` importing from `lucide-react` — every other
icon usage goes through `Icon`/`ICONS`/`IconName`, so the icon set is a closed, typed vocabulary
rather than an open door to any lucide glyph. `size` is constrained to `14 | 16 | 20`; a `label`
prop toggles between `aria-hidden` (decorative) and `aria-label` (meaningful).

**`StatusPill`** merges `runStatusMeta` / `agentRunStatusMeta` / `delegationStatusMeta`
(`lib/status.ts`, E-11/D-100 — each individually default-less/exhaustive over its own status union)
into one lookup keyed by status string, with its own `?? idle` fallback so an unrecognized string
never throws. It renders a small `aria-hidden` color **dot** (`meta.dot`) next to an uppercase
**text label** (`meta.text` color, `meta.label` or a caller override) — precisely *dot + label*,
not *icon + label*: the dot is a decorative color swatch, never a `lucide` `Icon` instance. The
governing rule is broader than StatusPill alone — **color never carries meaning alone** — and both
patterns satisfy it: StatusPill by always pairing its dot with a readable word, other status sites
(e.g. `ProjectCard`'s CI line) by pairing a real `Icon` with visible text.

Two shared components live in `web/src/components/`, not `web/src/ui/`, because they predate this
program (P4 E-30) and were reskinned onto the new tokens rather than rebuilt:
- **`Tabs.tsx`** — the one canonical underline tab bar (`role="tablist"`/`aria-selected`), generic
  over a caller's value union.
- **`SegControl.tsx`** — the one canonical pill segmented control (`role="group"`/`aria-pressed`),
  with `size`/`activeTone`/per-option `icon`/`count`/`disabled`.

Higher-level composite components — MessageDock, DelegationTree, RunConsole, ProjectCard, the
fleet/project GraphCanvas + NodeInspector, MicButton, CharterEditor, the AuthorityPanel,
LocalModels, and the widget grid's `WidgetShell`/`WidgetErrorBoundary` — are unchanged in structure
by this program (restyled onto the tiers/tokens above, not rebuilt) and stay documented in their
own sections earlier on this page (Message Dock, Agents hub, Runs, Knowledge graph spec, Settings +
Help, Home — Overview).

## Loading, empty & error states

- **Initial / no-cached-data loads** (`isPending` on the view's primary `useQuery`) render the
  **Skeleton primitives** (`Skeleton`, `SkeletonRow`, `SkeletonTile` — `web/src/ui/Skeleton.tsx`),
  each an `aria-hidden` block driven by the `.shimmer` CSS class (`index.css`: a ~1.6s
  linear-gradient sweep, `@keyframes shimmer`, disabled under `prefers-reduced-motion`).
  `SkeletonTile` bakes in its own `.glass-panel` tier, so a caller already inside a `glass-panel`
  ancestor cannot use it directly (nested backdrop-filter is banned) and must hand-roll bare
  `Skeleton` pieces instead — `ActiveRunsWidget.tsx` is the reference pattern, inline-commented.
  `EmptyState` has the same `.glass-panel`-icon-bubble limitation (its icon sits in a `glass-panel
  rounded-pill` wrapper); `ErrorState` does not — its container is opaque (`bg-surface border
  border-red/30`) with a bare, unwrapped icon, so it nests safely anywhere already. Widening
  `EmptyState`/`SkeletonTile` to accept a `tier?: 'panel' | 'solid'` prop (mirroring
  `KpiTile`/`GlassPanel`) is a tracked, unshipped follow-up (FU-2), not yet done.
- **Background refetches** of an already-populated view (e.g. a `refetchInterval` poll) do **not**
  show a skeleton or any shimmer/glint overlay — TanStack Query's default stale-while-revalidate
  behavior swaps in fresh data silently once it lands. The `days`-windowed Insights tabs
  additionally pass `placeholderData: keepPreviousData` so switching the 14/30/60-day toggle keeps
  the outgoing window's numbers on screen (no flash-to-empty) until the new window resolves —
  there is no separate visual affordance for "a refetch is in flight."
- **Empty results** render `EmptyState` (icon + headline + optional hint/action); **fetch failures**
  render `ErrorState` (`role="alert"`, message + optional Retry `Button`) — both `web/src/ui/`.

## Governance: the ui-token gate (`web/test/ui-token-gate.test.ts`)

- A vitest suite walks every `.ts(x)`/`.css` file under `web/src` (excluding `index.css` and
  `lib/tokens.ts`) and fails any file matching a raw Tailwind palette utility (e.g. `text-red-500`,
  `bg-slate-900` — regex over the full Tailwind color-name list) or a raw hex/rgb literal
  (longest-alternative-first, so an 8/4-digit alpha hex can't slip past a shorter partial match).
  Every color must instead resolve through a CSS custom property (`var(--…)`) or its Tailwind
  semantic class (`bg-accent`, `text-red`, …).
- `web/test/ui-token-allowlist.json` lists files still permitted to violate the gate. A second test
  in the same suite asserts every listed file still exists **and still actually violates** — a
  stale entry (a file since cleaned up) fails CI, so the list can only shrink honestly, never
  accumulate dead exemptions.
- The allowlist was seeded with the gate test itself (~task 3) and shrank wave by wave (primitives
  batch removed `ConfirmDialog.tsx`; the palette task took it 10→9; later page waves took it to 2
  remaining entries) until Task 22 (commit `fcc3284`) tokenized the last two files and reached
  **`[]` — empty**. The suite today runs `it.each` over literally every source file with zero
  exemptions.
- `lib/tokens.ts` is the ONE file exempt from the gate entirely (`EXEMPT` set in
  `ui-token-gate.test.ts`), for its `TOKEN_FALLBACKS` hex mirror (above). Every other file,
  including `pages/TerminalPage.tsx`, is fully gate-compliant with zero exemption: xterm's canvas
  theme option cannot consume a CSS `var()` directly, so `TerminalPage.tsx` reads the color via
  `readToken('--terminal-bg')` (a JS read through `lib/tokens.ts`, not a raw literal) and its two
  DOM-styled panes use `var(--terminal-bg)` inline — Task 22 (commit `fcc3284`) removed the file's
  prior raw hex literals and moved it onto the token, which is why the allowlist could drop it and
  still reach empty.

## Accessibility & quality bar

Full keyboard navigation (sidebar `g` chords, `j/k` lists, Ctrl/Cmd+K everywhere) · visible focus
rings (accent) · WCAG AA contrast on all text · reduced-motion respects OS setting · 60fps graph
interactions on a mid laptop; degrade node count before frame rate.
