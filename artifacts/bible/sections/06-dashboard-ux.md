---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-06-10
---

The dashboard is the operator's **source of truth** and is held to product quality, not internal-tool quality. IA: **Command Deck** (decision D-006, mockups approved 2026-06-10). Design language: **precision minimal** (decision D-007).

## Frame — four persistent zones

```
┌──┬─────────────────────────────────────────────────┐
│⚡│  ⌘K Ask K / jump anywhere…           ● core ok  │  command bar
│⌂ ├─────────────────────────────────────────────────┤
│▦ │                                                 │
│◉ │                   STAGE                         │  swappable per
│▶ │   (home · project workspace · graph · runs …)   │  destination
│✓ │                                                 │
│⚒ ├─────────────────────────────────────────────────┤
│∿ │ ● verify: gitnexus tests 14/20 · ● PR #42 review│  activity strip
│▤⚙│                              3 runs · $1.84 ▸⏸ │
└──┴─────────────────────────────────────────────────┘
```

### Icon sidebar (52px, left)

⌂ **Home** · ▦ **Projects** · ◉ **Fleet Graph** · ▶ **Runs** · ✓ **Tasks** · ⚒ **Skills** · ∿ **Metrics** · ▤ **Docs** · ⚙ **Settings** — tooltips on hover, active destination gets the indigo pill, keyboard `g` then first letter (`g p` → Projects).

### ⌘K command bar

One input, two behaviors, ranked in a single result list:
- **Dispatch:** natural language → confirm-card (target project, model, est. scope) → supervised run. Inside a workspace the dispatch is automatically project-scoped.
- **Navigate:** fuzzy jump to any project, run, PR, task, bible section, or skill.

### Activity strip (bottom, always visible)

Live runs with pulsing status dots and one-line progress, last completed action, day totals (runs · cost · tokens), pause-all. Click any entry → full run console.

## Home stage

1. **Metrics row** — tokens today, cost today, active runs, open tasks, fleet health (mono numerals, sparkline per card, click → Metrics filtered).
2. **Project cards** — sorted by *needs attention*. Each card: name, status dot, CI state, open PRs, bible freshness, activity sparkline, one suggested action ("▶ run verification"). Amber/red cards float to the top; a healthy fleet reads as a calm grid.
3. **Fleet graph pane** — projects as nodes sized by activity, colored by health; edges = shared dependencies and cross-project references. Click a node → that project's workspace.

## Project workspace — 7 tabs

| Tab | Content |
|-----|---------|
| **Overview** | health score breakdown, latest verification summary, recent runs, open PRs, bible freshness, quick actions |
| **Knowledge Graph** | per-project graph, first-class (below) |
| **Runs** | this project's runs: live consoles, history, replay from the event log |
| **Tasks** | project tickets, optional GitHub Issues sync, dispatch-agent-on-task |
| **PRs & CI** | open PRs with check status, diff links, Actions run history |
| **Verification** | report timeline, findings list with severity, fixes applied, re-run button |
| **Bible** | compiled bible rendered in-app; per-section edit (md) + recompile |

## Knowledge graph spec (fleet + per-project)

- **Renderer:** `react-force-graph` (WebGL) — handles thousands of nodes; Canvas/SVG fallback unnecessary.
- **Data source:** GitNexus indexes per project (Phase 2); fleet edges from manifest/dependency scanning.
- **Level of detail:** modules → files → symbols, plus a *hot paths* overlay (recent run activity). Double-click expands a node one level; breadcrumb chips track depth.
- **Node inspector** (right panel on select): live facts — file/symbol counts, failing tests originating here, last-touched-by (run/PR), bible links — and **dispatch actions**: "fix failing tests in this module", "explain this subsystem", "open impact analysis".
- **Interactions:** scroll = zoom, drag = pan, `f` = fit, search filters in place by dimming non-matches (never re-layouts under the user).
- Health/status colors the graph: failing modules glow red, untested amber — the graph is a *diagnostic surface*, not decoration.

## Design tokens

| Token | Value |
|-------|-------|
| bg / surface / raised | `#0a0a0f` / `#111116` / `#16161d` |
| hairline border | `1px #26262e` |
| text / muted | `#e7e7ea` / `#8b8b93` |
| accent — interactive only | `#6366f1` (hover `#818cf8`) |
| status | `#22c55e` · `#eab308` · `#ef4444` |
| type | Inter 13/14px UI · JetBrains Mono for numerals, ids, code |
| radius | 8px panels · 6px controls |
| motion | 150ms ease-out micro · 250ms stage transitions · pulse only on genuinely live elements |

**Rules:** color carries meaning or stays out; density over whitespace; no decorative animation; charts and graphs are the heroes and the chrome stays quiet; every number is mono so columns of metrics align.

## Component inventory (shadcn/ui base)

Command (⌘K) · Card · Tabs · Badge · Tooltip · Dialog (confirm-cards) · Table (runs/PRs) · Resizable panels (graph + inspector) · Sonner toasts (run completion) — plus custom: MetricCard, ProjectCard, ActivityStrip, GraphCanvas, NodeInspector, RunConsole (exists), DocViewer (exists).

## Accessibility & quality bar

Full keyboard navigation (sidebar `g` chords, `j/k` lists, ⌘K everything) · visible focus rings (accent) · WCAG AA contrast on all text · reduced-motion respects OS setting · 60fps graph interactions on a mid laptop; degrade node count before frame rate.
