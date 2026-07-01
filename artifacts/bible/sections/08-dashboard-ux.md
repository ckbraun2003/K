---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-07-01
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

> **Status.** The agent-first surfaces below (K-home, Chief, Orchestrators + detail, Workflows +
> detail, the org/MCP authority panel) are **PLANNED (Phase 5)** — this section is their UI spec.
> The surfaces they reorganize (Runs + rich console, Graph, Metrics, Routing, Terminal, Settings,
> the 7 project tabs) **exist today**; this section is now a *spec*, and the as-built implementation
> history (Phases G / H / 4) lives in §13 Observability → *Implementation history*.

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

### ⌘K / K — the one front door

**K (⌘K) is the only dispatch surface.** One input, two behaviors ranked in a single result list:
- **Ask / dispatch:** natural language → **K routes it** — logistics it handles itself, an
  engineering goal to the **Chief**, or a scoped job to a **specific lead** — and shows the chosen
  **route inline before send** ("→ Frontend lead · sonnet · ~small"). **Send** fires immediately with
  a **5 s undo** toast; a full confirm-card appears **only on escalation** (T3 authority /
  cross-project / a destructive kill·delete·reassign). *Force a specific lead* is an **advanced
  toggle**, not the default. Inside a workspace the composer is project-scoped.
- **Navigate:** fuzzy jump to any project, run, PR, work-item, orchestrator, workflow, or bible section.

**Every per-screen `⚡` is a scoped prefill of this one composer** — it opens K pre-targeted to the
lead / project / symbol in view (and pre-fills the route), never an independent dispatch surface.
There is exactly one place work is dispatched.

### Activity strip

**Live-only** — what is **running right now** across all tiers, with pulsing status dots, one-line
progress, last completed action, and pause-all. Click any entry → its full run console. **Day totals
($ / runs / tokens) live only in Metrics** — the strip never prints aggregates (metric uniqueness:
every number appears in exactly one place).

## Direct — the org surfaces (PLANNED, Phase 5)

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

### Chief — the single org-status home

The one place to see the whole org at once: the active **objectives**, **one whole-org delegation
tree** (the shared DelegationTree component below, scoped to every lead), the **autonomous-wake
history** (schedule/event triggers that woke the org), and a **thin health line** that links out to
**Metrics** and **Projects**. It is the org-status home — **not a full health strip** (those numbers
live in Metrics) and **not a second authority panel** (the authority map lives in Settings /
Orchestrator detail). Reports the Chief produces for the user surface here and on K-home.

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
> + a slim `rosterVitals`), so both surfaces derive a lead identically. **Deferred to P5.3b:** the
> `workflow_definitions` table + Workflows list/detail UI and the **Settings org-default** authority/MCP
> panel (per-lead overrides ship now; the org-default they inherit from is the P5.3b half).

### Workflows + workflow detail

**Workflows** lists the named definitions; **workflow detail** shows one definition's role sequence,
prompt scaffold, and cross-project scope flag. The previously-abstract standalone "Workflows
diagram" is **folded into** orchestrator/workflow detail, where it has real context (a lead actually
running it) rather than floating on its own.

Likewise, the standalone **Skills** destination folds into the orchestrator-detail **skills
editor** above, where each skill is scoped to the lead that uses it rather than floating in a
global list.

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
| **Artifacts** | this project's artifacts as a gallery, each in a sandboxed iframe; per-artifact markdown edit + bible recompile |

## Observe — the watch surfaces (today)

- **Runs + rich run console.** Runs render as **structured, collapsed-by-default** items — commands
  (`$ …` with output on expand), file ops (Write preview, Edit/MultiEdit diff hunks), and delegated
  sub-agents (type + label, full prompt + result on expand). A **Console ↔ Timeline** toggle exposes
  the replayable per-seq event log. Interactive runs show an **answer box** (ask → answer → continue)
  with **End session** and **Compact context**, plus a **`ctx X / Y · Z%`** pressure meter. (Internals
  in §13.)
- **Graph (3D).** Fleet + per-project knowledge graphs (below).
- **Metrics.** Tokens / cost / run trends over time (stacked-SVG charts).
- **Routing.** Model-routing outcomes — cost / latency / success by provider+model.
- **Evals.** The behavioral eval subsystem (§07): systems, runs with progress, a per-system pass-rate /
  discrimination / regression report, the raw results table, and a **gated Run** (dry by default — a real
  token-spending run requires an explicit opt-in that resets on every dialog open). (Internals in §07.)
- **Terminal.** A guarded `node-pty` web terminal (default-off; scoped `TERMINAL_TOKEN`).

## Settings + Help

- **Settings** — provider/auth **status** cards (claude / ollama / voice / github / auth posture, **no
  secrets**), the **guarded global CLAUDE.md editor** (fixed path, gitnexus block preserved, atomic
  write, backups, confirm-before-save), and a **NEW org-default authority / MCP panel** (PLANNED) —
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
- Live state always streams over the existing WebSocket; the UI never blocks on a poll.

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
