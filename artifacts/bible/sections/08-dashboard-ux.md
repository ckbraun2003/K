---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-07-13
---

The dashboard is the **window into the agent organization** (§03) — held to product quality, not
internal-tool quality. **UI Simplification (D-101..D-106)** re-frames it a second time: P4's
9-item flat rail (D-096) still asked the operator to pick between near-duplicate org/insight
surfaces; this pass **folds the rail to 6 primary tabs** — **K (Home) · Personal · Agents · Runs ·
Insights · Projects** — plus a Help/Settings footer, and replaces the ⌘K CommandBar palette +
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

### Sidebar IA — the 6-tab rail (D-101)

**`KNOWN_VIEWS`** (`web/src/lib/route.ts`) is now 13 entries: the 6 primary destinations +
`settings` (Help, the other footer rail entry, deep-links into `docs` and adds no view of its own),
plus `orchestrator` / `project` / `verify` / `docs` / `skill-creator` / `timeline` (drill-ins
reached from a hub, never rail buttons themselves). Every view string this restructure removed keeps
a `VIEW_REDIRECTS` entry (Retirements & redirects, below) — the redirect **replaces** the history
entry (`history.replaceState`, no Back-trap), and `resolveRoute` is idempotent (a canonical view is
never a redirect key).

| Rail | Route | Absorbs | Purpose |
|------|-------|---------|---------|
| ⌂ **K** *(landing)* | `#/` | K-home | **Chat** with K (default) or **Overview** — a SegControl toggle, not two routes |
| ☑ **Personal** | `#/personal` | Inbox · Tasks · Chats · Memories | your needs-you queue, work items, chat-thread management, and durable memories — 4 tabs |
| ♛ **Agents** | `#/agents` | Org · Skills · Workflows | the agent organization — **Org** (Roster/Tree/Graph), **Skills** (catalog), **Pipelines** (named workflow defs) — 3 tabs |
| ▶ **Runs** | `#/runs` | — | live + past runs with the rich console, now a plain master-detail (no Workflows sub-tab — Pipelines owns that now) |
| ∿ **Insights** | `#/insights` | Metrics · Routing · Evals | **4 tabs** — Overview (deterministic deltas + anomalies) · Charts · Routing · Evals |
| ▦ **Projects** | `#/projects` | — | the fleet; each opens its 7-tab workspace |
| **Footer** | ❔ **Help** · ⚙ **Settings** | Terminal | Help opens this bible; Settings hosts diagnostics terminal, CLAUDE.md editor, org-default authority/MCP panel |

The active destination sits on a translucent-blush glass pill (`aria-current="page"`); `g` + first
letter jumps (`web/src/lib/chords.ts`: `h`→Home, `u`→Personal, `a`→Agents, `r`→Runs, `n`→Insights,
`p`→Projects, `d`→Docs, `,`→Settings — unchanged by this restructure); the rail collapses to
icons-only (state persisted in `localStorage`). Personal carries a needs-you count badge and Runs
carries an active/parked-runs badge, both sharing the same query keys their pages use (zero extra
fetches). **Docs is not a top-level destination** — reachable via footer Help, edit-in-place per
section.

> **As-built.** `web/src/shell/Sidebar.tsx`'s `DESTINATIONS` array is the 6 primary + 2 footer + 3
> hidden (`docs`, `skill-creator`, `timeline` — kept only so `TopBar` can resolve a label for a view
> reached indirectly). `Shell.tsx` routes `home → HomePage`, `personal → PersonalPage(tab)`,
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

## Personal hub (D-101, 4 tabs)

`PersonalPage` — one `Tabs` surface, mirrored by `AgentsPage`'s shape:

| Tab | Content |
|-----|---------|
| **Inbox** (default) | the needs-you queue — moved intact from the old standalone InboxPage; still the same **union over 5 sources**, read live, never a table (below) |
| **Tasks** | full work-item management — a **Personal/Org** `SegControl` over the durable `work_items` store (ported from K-home's old "Your work" card) plus read-only **Notes** and **Schedule** cards |
| **Chats** | the full thread **management** surface — every thread including archived, rename/archive/unarchive/permanently-delete (delete is confirm-gated, cascades server-side, and a thread with a live run 409s inline in the dialog) |
| **Memories** | the operator's own durable **user-memories** store (below) — add / inline-edit / confirm-gated delete, with a **"→ from chat"** link back to the source thread when K saved the memory itself |

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

## Agents hub (D-101, 3 tabs)

`AgentsPage` merges Org + Skills + the former standalone Workflows page under one `Tabs` surface:

| Tab | Content |
|-----|---------|
| **Org** (default) | the roster of leads behind a **Roster / Tree / Graph** `SegControl` (`OrgPage`) — unchanged from P4's "one org surface" (D-096): Roster is slim cards, Tree is the whole-org DelegationTree, Graph is the fleet 3D graph |
| **Skills** | the capability catalog — unchanged 4 routed sub-tabs: Catalog · MCP · Hooks · Automations (below) |
| **Pipelines** | named workflow **definitions** — the former standalone Workflows page, folded in here rather than under Runs (its P4 home); a definition's role sequence, prompt scaffold, cross-project flag, and the "Run this workflow" launcher |

### Orchestrator detail (drill-in, `#/orchestrator/:id`)

Reached from Org → Roster → **Open**, not a rail destination itself. Six tabs now: **Charter · 
Skills · Tools · MCP servers · Memory · Runs** (Task 17 added **Runs** — the lead's recent activations,
measured `RunStatus` + `cost_usd` resolved server-side — and gave **Memory** a
**Pending / Accepted / Rejected** `SegControl`, was accepted-only). The header carries a **per-lead
recent-cost line** sourced from `GET /api/metrics/recent-actuals` — **measured** median/p90 of
stored run costs, never price × token estimation — alongside the existing recent-health line and
`effectiveModel` chip. The **per-lead authority override panel** still reads "inherits the org
default unless overridden"; the org-default itself is edited only in Settings.

### Skills — the capability catalog (unchanged)

Still **one destination, four routed tabs** — Catalog (source badge, model-compat badge, est-token
chip, enable toggle, SKILL.md preview) · MCP (tier-template + discovered-host servers behind the
TrustDialog) · Hooks (read-only host-hook visibility) · Automations (triggers, schedules, eval
history) — headed by the `CapabilityStatRow` totals strip. Content is unchanged from the
host-integration program (D-069..D-071); only its address moved from a standalone rail entry to
Agents → Skills.

## Runs (rail entry, now a plain master-detail)

**Runs no longer carries a Workflows sub-tab** — that content moved to Agents → Pipelines (above),
so `RunsPage` is now exactly a `RunList` + `RunConsole` split with nothing else. Runs render as
**structured, collapsed-by-default** items — commands (`$ …` with output on expand), file ops (Write
preview, Edit/MultiEdit diff hunks), and delegated sub-agents (type + label, full prompt + result on
expand). A **Console ↔ Timeline** toggle exposes the replayable per-seq event log. Interactive runs
show an **answer box** (ask → answer → continue) with **End session** and **Compact context**, plus
a **`ctx X / Y · Z%`** pressure meter. (Internals in §13.)

## Insights (4 tabs, unchanged)

**Overview** (deterministic deltas + z-score anomalies, measured-only, no LLM) · **Charts**
(tokens/cost/run trends, KPI tiles, cost-by-lead, error-rate, latency p50/p95, success+latency day
trends) · **Routing** (model-routing outcomes — cost/latency/success by provider+model) · **Evals**
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

## Retirements & redirects (D-106)

Every view string this restructure removed from `KNOWN_VIEWS` keeps a `VIEW_REDIRECTS` entry
(`web/src/lib/route.ts`) so a bookmarked or shared legacy hash still resolves — applied via
`history.replaceState` (never a push), so Back never bounces through a dead intermediate hash:

| Legacy hash | Redirects to |
|-------------|---------------|
| `#/chief` | Agents → Org → Tree |
| `#/orchestrators` | Agents → Org → Roster |
| `#/graph` | Agents → Org → Graph |
| `#/metrics` | Insights → Charts |
| `#/routing` | Insights → Routing |
| `#/evals` | Insights → Evals |
| `#/workflows[/:id]` | Agents → Pipelines[/:id] |
| `#/workflow-detail/:id` | Agents → Pipelines/:id |
| `#/memory` , `#/lessons` | Personal → Inbox |
| `#/terminal` | Settings |
| `#/org[/:seg]` (P4-era) | Agents → Org[/:seg] |
| `#/skills[/:tab]` (P4-era) | Agents → Skills[/:tab] |
| `#/inbox` (P4-era) | Personal → Inbox |
| `#/runs/workflows[/:id]` | Agents → Pipelines[/:id] — plain `#/runs/:runId` is unaffected (identity redirect, `resolveRoute` never re-navigates a real run id) |

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

- **The Inbox tab (Personal) is THE "needs-YOU" surface.** A **UNION over five sources** — plan
  approvals (runs parked at `awaiting_plan`), `awaiting_input` parks, pending lessons (§04),
  untrusted MCP servers, and review-ready runs. It is **a query, never a table** (D-081): each item
  is read live from its own authoritative source, so it can never drift out of sync.
- **Dismissal semantics.** A review-ready run dismisses via a stamp-once `runs.reviewed_at`. An
  untrusted-MCP card dismisses via an `inbox_dismissed_hash` pinned to the server's `config_hash` —
  a later config drift re-surfaces the card.
- **Notification rules and channels.** A seeded `notification_rules` table maps event key → channel
  (in-app and/or browser). The in-app center is durable; the browser leg is transient (dedupes on
  status transitions, fires only when the tab is hidden AND permission is granted, gesture-requested).
  `memory_saved` (D-104) is one such event key, seeded `inapp: true` by default.

## Settings + Help

- **Settings** — provider/auth status cards (no secrets), the guarded global CLAUDE.md editor, and
  the **org-default authority / MCP panel** — per-lead overrides live on orchestrator detail
  ("inherits org default unless overridden"); Settings owns the default, detail owns the delta.
- **Claude default model** — a Settings picker sets the global Claude default model
  (`app_config`-managed, applies to the next run, no restart). The Dock's `KAskBody.model` override
  still overrides it for a single dispatch.
- **Local models (Ollama)** — installed models with an active badge + selector (live, no restart),
  per-model Remove, a curated catalog with a "fits on disk?" badge and Pull with a live progress bar.
- **Voice transcription** — a reusable push-to-talk `MicButton` wired into the Message Dock composer
  and the run-console HITL reply box: hold to record → `POST /api/transcribe` (core proxies to a
  local Whisper server; the browser holds no key) → the transcript lands as ordinary text for review
  before send. Audio is transcribed locally and never leaves the box.
- **Help** — opens this bible (and the `g d` / footer chord).

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
  *Agents › Org › \<name\>*, *Agents › Pipelines › \<name\>*, *Projects › \<name\>*.
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

## Design tokens (vivid midnight-glass — UI Polish, D-107)

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
| `.glass-chrome` | `--glass-chrome-bg` rgba(42,26,71,.55) | `blur(24px) saturate(1.4)` | (caller's) | persistent shell chrome — Sidebar, TopBar, the Message Dock bar |
| `.glass-panel` | `--glass-panel-bg` rgba(42,26,71,.72) | `blur(16px) saturate(1.2)` | 18px | in-flow cards/panels — widget cells, KPI tiles, summary cards |
| `.glass-overlay` | `--glass-overlay-bg` rgba(51,32,92,.82) | `blur(28px) saturate(1.4)` | 18px | floating/portal surfaces — Dialog, Tooltip, popovers, the Message Dock float overlay |
| `.surface-solid` | `--surface` (opaque) | none | 14px | dense repeated rows — fleet/roster grids, list rows |

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
