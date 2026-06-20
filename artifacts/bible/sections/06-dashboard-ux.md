---
title: Dashboard — Command Deck
icon: "▣"
status: active
updated: 2026-06-20
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

## Phase G — Implemented (✓ complete 2026-06-18)

All items below were delivered in Phase G (G-1 through G-6):

### Project Workspace — 7-tab scaffold (G-1)

- Hash-segment routing: `#/project/:id/tab` with `subParam` support in `route.ts`
- Roving `tabIndex` keyboard navigation across all 7 tabs
- Tab order: Overview · Knowledge Graph · Runs · Tasks · PRs & CI · Verification · Bible

### Overview, Verification, Bible tabs (G-2)

- **Overview tab**: health score breakdown, latest verification summary, recent runs, open PRs, bible freshness, quick actions
- **Verification tab**: report timeline, findings list with severity badges, fixes applied, re-run button; fetches from `GET /api/projects/:id/verifications`
- **Bible tab**: compiled bible rendered in an iframe; per-section edit modal (markdown) + recompile trigger via `POST /api/bible/compile`

### Runs, Tasks, PRs & CI tabs (G-3)

- **Runs tab**: project-scoped run list with live status indicators, run dispatch form, RunConsole embedded
- **Tasks tab**: `project_tasks` table (SQLite, added in `db.ts`); CRUD via `GET/POST /api/projects/:id/tasks` and `PATCH /api/projects/:id/tasks/:taskId`; dispatch-agent-on-task shortcut
- **PRs & CI tab**: open PRs with check status, diff links, Actions run history; PR creation modal (see Agent-opens-PR below)

### Knowledge Graph tab + Fleet Graph (G-4)

- **Knowledge Graph tab**: per-project ForceGraph2D rendering from `GET /api/projects/:id/graph` (reads `.gitnexus/graph.json`); node inspector right-panel on click showing symbol type and dispatch actions; stale-index banner when graph data is unavailable
- **Fleet Graph**: project-nodes graph on Home stage, sized by activity and colored by health score; full-screen `/graph` route accessible via sidebar
- **Graph API**: `GET /api/projects/:id/graph` returns `{ nodes, links, stale }` — normalizes GitNexus `graph.json` shape (supports both `edges` and `links` keys)

### Agent-opens-PR (G-5)

- **`createPR` backend** (`core/src/github.ts`): invokes `gh pr create` via `execa` with an argv array (never shell string — command injection safe); sanitizes `gh` stderr before surfacing errors; throws descriptive error on non-JSON stdout
- **Route**: `POST /api/projects/:id/prs` — validates body via `CreatePrOptsSchema` (Zod); 400 if project has no `githubRemote`; 201 with `{ number, url, title, state }` on success
- **PR modal in PRs & CI tab**: form for `title`, `body`, `head`, `base`; calls `api.projects.createPr()`; shows error toast on failure
- **"Create PR from Run →" footer** in `RunConsole`: appears when run is terminal (`done`/`error`/`killed`/`interrupted`) and has an associated `projectId`; navigates to `#/project/:id/prs-ci`

### G-6 close-out

- `core/test/tasks-route.test.ts`: full CRUD coverage (GET 404/200, POST 400/201, PATCH 400/404/200, `completedAt` lifecycle)
- `core/test/create-pr.test.ts`: `createPR` unit tests (happy path, non-JSON error, execa-throws error, argv-array guard) + route integration tests
- Bible §06 and §07 updated to reflect Phase G completion
- `.env.example` added to repo root with all documented environment variables

## Phase H — Knowledge graph engine + experience polish

Phase H takes the Phase-G surfaces from "wired" to "finished": the per-project graph gains a real build/refresh engine, the design language gains a **hybrid-glass** layer over precision-minimal, motion is centralized and reduced-motion-safe, and the UI itself becomes a self-demonstrating artifact.

### Hybrid glass (extends D-007, see D-009)

Precision-minimal (D-007) still governs density, color discipline, and mono numerals. Hybrid glass adds a thin translucent layer to **hero surfaces only** — never to dense data tables — so depth never fights legibility.

- **Glass tokens / utilities** (`web/src/index.css`): a `--glass-bg` surface (`rgba(20, 20, 27, 0.62)`), `backdrop-filter: blur(20px) saturate(160%)` (with the `-webkit-` prefix), and a hairline border + soft drop-shadow. Exposed as a reusable utility so hero surfaces opt in consistently.
- **`@supports` fallback:** an `@supports not (backdrop-filter: blur(1px))` block swaps the translucent fill for an opaque `--raised` surface, so browsers without backdrop-filter still get a solid, legible panel (no transparent-over-text failure mode).
- **Applied to hero surfaces only:** command bar, modals/confirm-cards, the graph node inspector, and the activity strip. Data tables, run lists, and the bible body stay flat per D-007.

### Motion (reduced-motion-safe)

- **`web/src/lib/motion.ts`**: the single source of motion variants (stage/tab transitions, micro-interactions) so durations/easings match the §06 motion tokens (150ms micro · 250ms stage) instead of being re-specified per component.
- **`MotionConfig` reduced-motion:** a top-level `MotionConfig reducedMotion="user"` makes every variant honor the OS *prefers-reduced-motion* setting automatically; pulse/animation is reserved for genuinely-live elements and gated by `@media (prefers-reduced-motion: reduce)` in CSS.
- Quality bar unchanged: 60fps graph interactions; degrade node count before frame rate.

### Knowledge graph engine (see D-009)

The graph spec above describes the *experience*; Phase H adds the *engine* behind it, orchestrated through GitNexus:

- **Build / refresh:** `project_graphs` table (status · built_at · last_commit · node/edge counts · error) plus `POST /api/projects/:id/graph/build`, which runs `npx gitnexus analyze` via an injected `analyze` seam (an in-flight guard prevents concurrent builds; CI never invokes real GitNexus). `GET …/graph` reports `status` + `stale`; a transient `graph_update` WS message rides the existing broadcast path so the UI auto-refreshes (Build/Refresh button, building spinner, last-built / stale / error chips).
- **Live node enrichment:** `GET …/graph` enriches nodes with live facts — last-touched run, verify findings, and whether the symbol is referenced in the bible (bible scoping is restricted to the harness project only).
- **Dispatch from a node:** `POST /api/projects/:id/graph/dispatch` launches a node-scoped supervised run via the existing `startRun` seam (single-line input guarded with a 400); the node inspector surfaces a confirm-card → dispatch → transient notice flow.
- **Auto-reindex:** an `onRunUpdate` subscriber marks a project's graph stale and triggers a per-project, debounced, guarded rebuild after a run that touched it (env flag `GRAPH_AUTO_REINDEX`, default on).
- **Renderer note:** graph views import the renderer-specific `react-force-graph-2d` subpackage (default export), never the `react-force-graph` aggregate — the aggregate references a non-existent global `AFRAME` and throws at module-eval time, blanking every route (guarded by a static import test).

### UI as a self-demonstrating artifact (see D-010)

- The interactive **`ui-demo`** (a self-contained mini Command Deck in the hybrid-glass look) is compiled to a first-class artifact via `core/src/ui-artifact.ts` (`compileUiArtifact`) and `POST /api/ui-artifact/compile`. Its rich inline CSS+JS are written to disk **verbatim** (bypassing the generic artifact sanitizer) and served back through the DocViewer's sandboxed iframe (`allow-scripts`, **no** `allow-same-origin`), so the demo is fully offline and sandbox-safe (no CDN/font fetches, no `localStorage` reliance).
- The **`create-web-ui-artifact` skill** (`.claude/skills/create-web-ui-artifact/SKILL.md`) is the UI counterpart to `onboarding`: for a web-UI project it inspects routes/components, authors a project-specific self-contained demo, and compiles it (with `{ projectId }`) into a per-project artifact (`project-<id>-ui-demo`). It is seeded into the skills registry as a manual-trigger workflow, so it is triggerable from the **Skills** tab alongside `onboarding` and `verify-project`.
